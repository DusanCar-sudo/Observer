/**
 * Fixture corpus loader with integrity verification.
 *
 * A fixture that silently rots is worse than no fixture: every later acceptance
 * criterion in this project says "verified on every fixture", so the corpus must be
 * trustworthy bytes, not hopeful bytes. Therefore:
 *
 *  - every committed payload file is sha256 + length verified against the manifest
 *    at load time;
 *  - generated payloads (the >5 MB body) are regenerated and verified against the
 *    sha256 pinned in the manifest — which doubles as a cross-platform determinism
 *    check every time the suite runs, including in CI;
 *  - structural invariants are validated (host header first, content-length matches
 *    the body, terminate offsets inside the scripted stream) so a malformed fixture
 *    fails at load with a named reason instead of producing a mystery diff at run.
 *
 * The loader NEVER parses fixture bodies as JSON. Payloads in, Buffers out.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGenerator } from './generators.js'
import { findHeader, serializeHead, SPLIT_GAP_MS } from './http.js'
import type {
  ExpectedArrival,
  FixtureJson,
  GeneratorSpec,
  Manifest,
  ManifestFileEntry,
  ManifestFixtureEntry,
  PayloadRef,
  ResolvedFixture,
} from './types.js'

export class FixtureIntegrityError extends Error {
  override name = 'FixtureIntegrityError'
}

function fail(fixtureId: string, detail: string): never {
  throw new FixtureIntegrityError(`fixture "${fixtureId}": ${detail}`)
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Walk up from `start` looking for `fixtures/corpus/manifest.json`. */
export function findCorpusDir(start?: string): string {
  let dir = start ?? path.dirname(fileURLToPath(import.meta.url))
  try {
    dir = realpathSync(dir)
  } catch {
    /* keep the logical path if realpath fails */
  }
  for (;;) {
    const candidate = path.join(dir, 'fixtures', 'corpus', 'manifest.json')
    if (existsSync(candidate)) return path.join(dir, 'fixtures', 'corpus')
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new FixtureIntegrityError(
        `could not locate fixtures/corpus/manifest.json walking up from ${dir} — run from inside the repo or pass an explicit dir`,
      )
    }
    dir = parent
  }
}

export const DEFAULT_TIMING = {
  mode: 'strict' as const,
  gapToleranceMs: 5,
  /**
   * Default TTFB budget for the differential (SUT minus baseline, single-shot
   * measurement). Deliberately looser than V4b's 5 ms acceptance number: that
   * criterion is a p50/p99 statistic over many requests which V4b's own harness
   * measures; a single-shot 5 ms bound on a shared CI runner would flake. The rig
   * still catches buffering proxies decisively — their TTFB delta is the sum of all
   * stream delays, orders of magnitude over any sane budget. Per-fixture overrides
   * exist for tighter budgets.
   */
  ttfbBudgetMs: 25,
}

export const LOOSE_TTFB_BUDGET_MS = 250

function timingOf(fx: FixtureJson): ResolvedFixture['timing'] {
  const mode = fx.timing?.mode ?? DEFAULT_TIMING.mode
  return {
    mode,
    gapToleranceMs: fx.timing?.gapToleranceMs ?? DEFAULT_TIMING.gapToleranceMs,
    ttfbBudgetMs:
      fx.timing?.ttfbBudgetMs ?? (mode === 'strict' ? DEFAULT_TIMING.ttfbBudgetMs : LOOSE_TTFB_BUDGET_MS),
  }
}

/**
 * Derive the expected arrival schedule from the script + resolved payload lengths.
 *
 * Models three realities the naive "one write = one arrival at delayMs" misses:
 *  - a `splitAfterBytes` write produces TWO arrivals, the continuation SPLIT_GAP_MS later;
 *  - the write AFTER a split continuation is scheduled from the script's cumulative
 *    deadline, so its observed gap is delayMs − SPLIT_GAP_MS (the continuation ate
 *    part of the interval);
 *  - a truncating `terminate` stops the schedule: destroy-after-write k delivers
 *    writes 0..k; destroy-after-body-bytes N delivers whole writes until N is
 *    reached, then ONE partial arrival (which may land on a split's first or
 *    second half).
 */
export function expectedArrivalsOf(fx: FixtureJson, payloadLengths: number[]): ExpectedArrival[] {
  const out: ExpectedArrival[] = []
  const terminate = fx.response.terminate ?? { kind: 'end' as const }
  let budget = terminate.kind === 'destroy-after-body-bytes' ? terminate.bodyBytes : Number.POSITIVE_INFINITY
  let prevWasSplit = false

  outer: for (let wi = 0; wi < fx.response.writes.length; wi++) {
    const w = fx.response.writes[wi]!
    const len = payloadLengths[wi] ?? 0
    if (terminate.kind === 'destroy-after-write' && wi > terminate.writeIndex) break
    const splitAt =
      w.splitAfterBytes !== undefined && w.splitAfterBytes > 0 && w.splitAfterBytes < len ? w.splitAfterBytes : undefined
    const parts = splitAt !== undefined ? [splitAt, len - splitAt] : [len]
    const baseGap = Math.max(0, w.delayMs - (prevWasSplit ? SPLIT_GAP_MS : 0))
    prevWasSplit = false
    for (let pi = 0; pi < parts.length; pi++) {
      const partLen = parts[pi]!
      const gap = pi === 0 ? baseGap : SPLIT_GAP_MS
      if (budget <= 0) break outer
      if (partLen > budget) {
        // This part is cut mid-flight: it still arrives, partially, as one arrival.
        out.push({ nominalGapMs: gap, splitContinuation: pi === 1 })
        budget = 0
        break outer
      }
      budget -= partLen
      out.push({ nominalGapMs: gap, splitContinuation: pi === 1 })
      if (pi === 1) prevWasSplit = true
    }
  }
  return out
}

interface IntegrityCtx {
  fixtureId: string
  dir: string
  files: Record<string, ManifestFileEntry>
  generated: Record<string, { spec: GeneratorSpec; sha256: string; bytes: number }>
  usedFiles: Set<string>
  usedGenerated: Set<string>
}

async function resolvePayloadRef(ref: PayloadRef, key: string, ctx: IntegrityCtx): Promise<Buffer> {
  if ('inline' in ref) {
    return Buffer.from(ref.inline, 'utf8')
  }
  if ('file' in ref) {
    const entry = ctx.files[ref.file]
    if (!entry) fail(ctx.fixtureId, `manifest has no integrity record for file "${ref.file}" (ref ${key})`)
    const full = path.join(ctx.dir, ref.file)
    const bytes = await readFile(full)
    if (bytes.length !== entry.bytes) {
      fail(ctx.fixtureId, `file "${ref.file}" is ${bytes.length} bytes but manifest records ${entry.bytes}`)
    }
    const actual = sha256(bytes)
    if (actual !== entry.sha256) {
      fail(ctx.fixtureId, `file "${ref.file}" sha256 ${actual} != manifest ${entry.sha256} — fixture corrupted or stale manifest`)
    }
    ctx.usedFiles.add(ref.file)
    return bytes
  }
  if ('generate' in ref) {
    const entry = ctx.generated[key]
    if (!entry) fail(ctx.fixtureId, `manifest has no integrity record for generated payload "${key}"`)
    const bytes = runGenerator(ref.generate)
    if (bytes.length !== entry.bytes) {
      fail(
        ctx.fixtureId,
        `generator "${key}" produced ${bytes.length} bytes but manifest pins ${entry.bytes} — generator drift; regenerate the corpus deliberately`,
      )
    }
    const actual = sha256(bytes)
    if (actual !== entry.sha256) {
      fail(
        ctx.fixtureId,
        `generator "${key}" sha256 ${actual} != pinned ${entry.sha256} — generator is not deterministic on this platform`,
      )
    }
    ctx.usedGenerated.add(key)
    return bytes
  }
  return fail(ctx.fixtureId, `payload ref ${key} is neither inline, file, nor generate: ${JSON.stringify(ref)}`)
}

export async function loadFixture(corpusDir: string, entry: ManifestFixtureEntry): Promise<ResolvedFixture> {
  const dir = path.join(corpusDir, entry.dir)
  const fxPath = path.join(dir, 'fixture.json')
  if (!existsSync(fxPath)) fail(entry.id, `missing ${fxPath}`)

  // fixture.json itself is integrity-checked when the manifest records it.
  const fxRaw = await readFile(fxPath)
  const fxEntry = entry.files['fixture.json']
  if (fxEntry) {
    if (fxRaw.length !== fxEntry.bytes || sha256(fxRaw) !== fxEntry.sha256) {
      fail(entry.id, 'fixture.json does not match its manifest record — stale manifest or corrupted fixture')
    }
  }
  let fx: FixtureJson
  try {
    fx = JSON.parse(fxRaw.toString('utf8')) as FixtureJson
  } catch (err) {
    fail(entry.id, `fixture.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (fx.id !== entry.id) fail(entry.id, `fixture.json id "${fx.id}" != manifest id "${entry.id}"`)

  const ctx: IntegrityCtx = {
    fixtureId: fx.id,
    dir,
    files: entry.files,
    generated: entry.generated ?? {},
    usedFiles: new Set(),
    usedGenerated: new Set(),
  }

  // ---- request ----
  const body = await resolvePayloadRef(fx.request.body, 'request.body', ctx)
  const headerPairs = fx.request.headers.map(([n, v]) => [n, v] as [string, string])
  if (headerPairs.length === 0 || headerPairs[0]![0].toLowerCase() !== 'host') {
    fail(fx.id, 'request headers must start with "host" — both runs must emit byte-identical request bytes, so Host is a fixed synthetic value, never port-derived')
  }
  const cl = findHeader(headerPairs, 'content-length')
  const te = findHeader(headerPairs, 'transfer-encoding')
  if (te !== undefined) fail(fx.id, 'chunked request bodies are out of scope for the V0 corpus (loader would need a request-side chunk decoder)')
  if (body.length > 0) {
    if (cl === undefined) fail(fx.id, 'request body is non-empty but no content-length header is declared')
    if (Number(cl) !== body.length) {
      fail(fx.id, `content-length ${cl} does not match body length ${body.length}`)
    }
  } else if (cl !== undefined && Number(cl) !== 0) {
    fail(fx.id, `content-length ${cl} declared but body is empty`)
  }
  const headBytes = serializeHead(`${fx.request.method} ${fx.request.target} HTTP/1.1`, headerPairs)

  // ---- response ----
  const payloads: Buffer[] = []
  for (let i = 0; i < fx.response.writes.length; i++) {
    payloads.push(await resolvePayloadRef(fx.response.writes[i]!.payload, `response.writes.${i}.payload`, ctx))
  }
  const totalPayload = payloads.reduce((n, b) => n + b.length, 0)
  const terminate = fx.response.terminate ?? { kind: 'end' as const }
  if (terminate.kind === 'destroy-after-write' && (terminate.writeIndex < 0 || terminate.writeIndex >= fx.response.writes.length)) {
    fail(fx.id, `terminate.destroy-after-write index ${terminate.writeIndex} out of range (0..${fx.response.writes.length - 1})`)
  }
  if (terminate.kind === 'destroy-after-body-bytes' && (terminate.bodyBytes < 0 || terminate.bodyBytes > totalPayload)) {
    fail(fx.id, `terminate.destroy-after-body-bytes ${terminate.bodyBytes} outside total payload bytes ${totalPayload}`)
  }
  if (fx.response.framing === 'length') {
    const declared = fx.response.contentLength ?? totalPayload
    if (terminate.kind === 'end' && declared !== totalPayload) {
      fail(fx.id, `content-length ${declared} != sum of write payloads ${totalPayload} with terminate:end — client would hang or see truncation the script did not intend`)
    }
  }
  for (let i = 0; i < fx.response.writes.length; i++) {
    const w = fx.response.writes[i]!
    if (w.delayMs < 0) fail(fx.id, `write ${i} has negative delayMs`)
    if (w.splitAfterBytes !== undefined && (w.splitAfterBytes <= 0 || w.splitAfterBytes >= payloads[i]!.length)) {
      fail(fx.id, `write ${i} splitAfterBytes ${w.splitAfterBytes} must be inside (0, payload length ${payloads[i]!.length})`)
    }
  }

  // ---- manifest coverage: every recorded file must actually be used ----
  for (const name of Object.keys(entry.files)) {
    if (name === 'fixture.json') continue
    if (!ctx.usedFiles.has(name)) {
      fail(fx.id, `manifest records file "${name}" that the fixture never references — stale manifest entry`)
    }
  }
  for (const key of Object.keys(ctx.generated)) {
    if (!ctx.usedGenerated.has(key)) {
      fail(fx.id, `manifest records generated payload "${key}" that the fixture never references — stale manifest entry`)
    }
  }

  const timing = timingOf(fx)
  if (timing.mode === 'strict') {
    for (let i = 0; i < fx.response.writes.length; i++) {
      const d = fx.response.writes[i]!.delayMs
      if (fx.response.writes.length > 1 && d < timing.gapToleranceMs && !(fx.response.writes[i]!.splitAfterBytes !== undefined)) {
        // Not fatal, but a strict-timing fixture whose gaps are near/below its own
        // tolerance measures noise, not fidelity. Fail loudly so the corpus stays honest.
        fail(fx.id, `write ${i} delayMs ${d} < strict gap tolerance ${timing.gapToleranceMs} — use loose timing or a bigger delay`)
      }
    }
  }

  return {
    id: fx.id,
    title: fx.title,
    provenance: fx.provenance,
    tags: [...fx.tags],
    ...(fx.notes !== undefined ? { notes: fx.notes } : {}),
    dir,
    request: { method: fx.request.method, target: fx.request.target, headerPairs, headBytes, body },
    response: {
      script: fx.response,
      payloads,
      expectedArrivals: expectedArrivalsOf(fx, payloads.map((b) => b.length)),
    },
    timing,
  }
}

export async function loadCorpus(corpusDir?: string): Promise<ResolvedFixture[]> {
  const dir = corpusDir ?? findCorpusDir()
  const manifestPath = path.join(dir, 'manifest.json')
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== 1) throw new FixtureIntegrityError(`unsupported manifest version ${String(manifest.version)}`)
  const out: ResolvedFixture[] = []
  for (const entry of manifest.fixtures) {
    out.push(await loadFixture(dir, entry))
  }
  return out
}
