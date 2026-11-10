/**
 * Differential comparison: baseline run (client -> mock upstream, direct) versus SUT
 * run (client -> system-under-test -> mock upstream).
 *
 * Comparison happens on RAW BYTES and ARRIVAL TIMELINES. Nothing here parses a body:
 * a rig that parses before comparing cannot detect chunk coalescing, cannot detect a
 * dropped unknown field that its own schema does not know, and cannot detect
 * re-serialisation that happens to round-trip through its parser. Those are precisely
 * the failure classes this project exists to catch, so the comparator is deliberately
 * dumber than the protocols it watches.
 *
 * Axes compared:
 *  - response status code + reason phrase (strict)
 *  - response headers: ordered pairs modulo the hop-by-hop ignore set (missing /
 *    extra / value / order)
 *  - response body bytes: sha256 verdict + diff regions with offsets, lengths, hex
 *  - upstream request body bytes (the V1/A1 axis): what the upstream saw through the
 *    SUT vs what the client sent
 *  - upstream request headers/line: parsed, same policy
 *  - arrival timeline: event count (coalescing/splitting), per-event boundary offsets,
 *    inter-event gaps vs baseline AND vs the script's nominal schedule, TTFB delta
 *  - truncation: framing completeness and exact truncation offset must match
 */

import { createHash } from 'node:crypto'
import { isHopByHop } from './http.js'
import type {
  ByteRegion,
  FidelityDiff,
  HeaderIssue,
  HeaderPairs,
  ResolvedFixture,
  RunSide,
  TimingDiagnostics,
} from './types.js'

export const MAX_DIFF_REGIONS = 64
const RESYNC_WINDOW = 16_384
const ANCHOR_LEN = 24
const MAX_BOUNDARY_DIFFS = 32
const MAX_GAP_DIFFS = 32

// ---------------------------------------------------------------------------
// Byte diff with offsets
// ---------------------------------------------------------------------------

function excerpt(buf: Buffer, from: number, len: number, max = 32): { hex: string; ascii: string; len: number } {
  const slice = buf.subarray(from, from + Math.min(len, max))
  let hex = ''
  let ascii = ''
  for (const b of slice) {
    hex += (hex ? ' ' : '') + b.toString(16).padStart(2, '0')
    ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'
  }
  return { hex, ascii, len }
}

export interface ByteCompareResult {
  equal: boolean
  regions: ByteRegion[]
  regionsTruncated: boolean
}

/**
 * Locate differing regions between two byte strings, reported as
 * {offset, op, baseline(len,hex,ascii), sut(len,hex,ascii)}.
 *
 * Strategy: trim the common prefix/suffix, then walk the middle with greedy
 * anchor-resync (a mismatch run ends when a 24-byte anchor of one side is found
 * within a 16 KiB window of the other, yielding insert/delete regions; otherwise the
 * run is emitted as a replace). Equality itself NEVER depends on this scan — the
 * sha256 verdict is computed separately; regions are diagnostics. The scan is capped
 * at MAX_DIFF_REGIONS regions, flagged via regionsTruncated when hit.
 */
export function diffBytes(baseline: Buffer, sut: Buffer, maxRegions = MAX_DIFF_REGIONS): ByteCompareResult {
  const lb = baseline.length
  const ls = sut.length
  if (lb === ls && baseline.equals(sut)) return { equal: true, regions: [], regionsTruncated: false }

  let p = 0
  const minLen = Math.min(lb, ls)
  while (p < minLen && baseline[p] === sut[p]) p++
  let s = 0
  while (s < minLen - p && baseline[lb - 1 - s] === sut[ls - 1 - s]) s++

  const A = baseline.subarray(p, lb - s) // baseline middle
  const B = sut.subarray(p, ls - s) // sut middle

  const regions: ByteRegion[] = []
  let truncated = false
  let i = 0
  let j = 0
  // Open replace-run start (lockstep walk while bytes differ and no resync anchor
  // is in sight); -1 when not inside a run.
  let runI = -1
  let runJ = -1

  const pushRegion = (op: ByteRegion['op'], ai: number, aEnd: number, bj: number, bEnd: number): void => {
    if (regions.length >= maxRegions) {
      truncated = true
      return
    }
    regions.push({
      offset: p + ai,
      op,
      baseline: excerpt(baseline, p + ai, aEnd - ai),
      sut: excerpt(sut, p + bj, bEnd - bj),
    })
  }
  const closeRun = (endI: number, endJ: number): void => {
    if (runI === -1) return
    if (endI > runI || endJ > runJ) pushRegion('replace', runI, endI, runJ, endJ)
    runI = -1
    runJ = -1
  }

  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      closeRun(i, j)
      i++
      j++
      continue
    }
    if (runI === -1) {
      runI = i
      runJ = j
    }
    // While a run is young, look for a resync anchor: a 24-byte slice of one side
    // occurring within 16 KiB of the other. That distinguishes an insertion or
    // deletion (resync found) from a genuinely rewritten span (no anchor in sight).
    if (i - runI < 64) {
      const anchorB = B.subarray(j, j + ANCHOR_LEN)
      const anchorA = A.subarray(i, i + ANCHOR_LEN)
      let posA = -1
      let posB = -1
      if (anchorB.length === ANCHOR_LEN) posA = A.indexOf(anchorB, i, Math.min(A.length, i + RESYNC_WINDOW))
      if (anchorA.length === ANCHOR_LEN) posB = B.indexOf(anchorA, j, Math.min(B.length, j + RESYNC_WINDOW))
      if (posA > i && (posB === -1 || posA - i <= posB - j)) {
        // Baseline has bytes the sut dropped.
        closeRun(i, j)
        pushRegion('delete', i, posA, j, j)
        i = posA
        continue
      }
      if (posB > j) {
        // Sut inserted bytes relative to baseline.
        closeRun(i, j)
        pushRegion('insert', i, i, j, posB)
        j = posB
        continue
      }
    }
    i++
    j++
  }
  // Close any open run, absorbing the leftover tail of whichever side is longer.
  if (runI !== -1 || i < A.length || j < B.length) {
    const startI = runI !== -1 ? runI : i
    const startJ = runJ !== -1 ? runJ : j
    const aLeft = A.length - startI
    const bLeft = B.length - startJ
    const op: ByteRegion['op'] = aLeft > 0 && bLeft > 0 ? 'replace' : aLeft > 0 ? 'delete' : 'insert'
    pushRegion(op, startI, A.length, startJ, B.length)
  }
  if (regions.length >= maxRegions) truncated = true
  return { equal: false, regions, regionsTruncated: truncated }
}

// ---------------------------------------------------------------------------
// Header diff
// ---------------------------------------------------------------------------

export function compareHeaderPairs(
  baseline: HeaderPairs,
  sut: HeaderPairs,
  extraIgnore: ReadonlySet<string> = new Set(),
): HeaderIssue[] {
  const keep = (n: string): boolean => !isHopByHop(n) && !extraIgnore.has(n.toLowerCase())
  const b = baseline.filter(([n]) => keep(n))
  const u = sut.filter(([n]) => keep(n))
  const issues: HeaderIssue[] = []

  const occurrences = (pairs: HeaderPairs, name: string): { pos: number; value: string }[] => {
    const out: { pos: number; value: string }[] = []
    pairs.forEach(([n, v], pos) => {
      if (n.toLowerCase() === name) out.push({ pos, value: v })
    })
    return out
  }
  const names = new Set<string>()
  for (const [n] of b) names.add(n.toLowerCase())
  for (const [n] of u) names.add(n.toLowerCase())

  for (const name of [...names].sort()) {
    const bo = occurrences(b, name)
    const uo = occurrences(u, name)
    const nCompare = Math.min(bo.length, uo.length)
    for (let k = 0; k < nCompare; k++) {
      if (bo[k]!.value !== uo[k]!.value) {
        issues.push({
          issue: 'value-mismatch',
          name,
          baselinePosition: bo[k]!.pos,
          sutPosition: uo[k]!.pos,
          baselineValue: bo[k]!.value,
          sutValue: uo[k]!.value,
        })
      }
    }
    for (let k = uo.length; k < bo.length; k++) {
      issues.push({ issue: 'missing', name, baselinePosition: bo[k]!.pos, baselineValue: bo[k]!.value })
    }
    for (let k = bo.length; k < uo.length; k++) {
      issues.push({ issue: 'extra', name, sutPosition: uo[k]!.pos, sutValue: uo[k]!.value })
    }
  }

  // Order check: only meaningful when the multisets match (otherwise the issues above
  // already explain the divergence). Sequence = lowercased names after filtering.
  const sameMultiset =
    issues.length === 0 ||
    issues.every((x) => x.issue === 'value-mismatch' || x.issue === 'reordered' || x.issue === 'request-line-mismatch')
  if (sameMultiset) {
    const bSeq = b.map(([n]) => n.toLowerCase())
    const uSeq = u.map(([n]) => n.toLowerCase())
    if (bSeq.length === uSeq.length) {
      let firstDivergence = -1
      for (let k = 0; k < bSeq.length; k++) {
        if (bSeq[k] !== uSeq[k]) {
          firstDivergence = k
          break
        }
      }
      if (firstDivergence !== -1) {
        issues.push({
          issue: 'reordered',
          name: '(order)',
          baselinePosition: firstDivergence,
          sutPosition: firstDivergence,
          baselineValue: bSeq.slice(firstDivergence, firstDivergence + 6).join(','),
          sutValue: uSeq.slice(firstDivergence, firstDivergence + 6).join(','),
        })
      }
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Full differential
// ---------------------------------------------------------------------------

function gapsOf(side: RunSide): number[] {
  const ev = side.client.bodyEvents
  const gaps: number[] = []
  for (let k = 0; k < ev.length; k++) {
    gaps.push(k === 0 ? (ev[0]!.tMs) : ev[k]!.tMs - ev[k - 1]!.tMs)
  }
  return gaps
}

export interface DiffRunResult {
  diffs: FidelityDiff[]
  diagnostics: TimingDiagnostics
}

export function diffRuns(
  fixture: ResolvedFixture,
  baseline: RunSide,
  sut: RunSide,
  opts: {
    headerIgnore?: readonly string[] | undefined
    timing?: { mode?: 'strict' | 'boundaries' | 'loose'; gapToleranceMs?: number; ttfbBudgetMs?: number } | undefined
  } = {},
): DiffRunResult {
  const diffs: FidelityDiff[] = []
  const extraIgnore = new Set((opts.headerIgnore ?? []).map((n) => n.toLowerCase()))
  const timing = {
    mode: opts.timing?.mode ?? fixture.timing.mode,
    gapToleranceMs: opts.timing?.gapToleranceMs ?? fixture.timing.gapToleranceMs,
    ttfbBudgetMs: opts.timing?.ttfbBudgetMs ?? fixture.timing.ttfbBudgetMs,
  }
  const diagnostics: TimingDiagnostics = {
    gapVsBaseline: { samples: 0, maxAbsDevMs: 0, meanDevMs: 0 },
    gapVsNominal: { samples: 0, maxAbsDevMs: 0, meanDevMs: 0 },
    chunkTransit: { samples: 0, maxMs: 0, meanMs: 0, toleranceMs: timing.gapToleranceMs, spikes: 0, alignment: 'index', emits: 0 },
    baselineTransit: { samples: 0, maxMs: 0, meanMs: 0 },
  }

  // ---- protocol-level sanity ----
  if (baseline.client.timedOut) {
    diffs.push({ kind: 'rig-error', detail: 'baseline run timed out — fixture script or rig is broken (the direct path must always work)' })
    return { diffs, diagnostics }
  }
  if (!baseline.client.head) {
    diffs.push({ kind: 'rig-error', detail: `baseline run received no response head (socketError=${baseline.client.socketError ?? 'none'})` })
    return { diffs, diagnostics }
  }
  if (!baseline.upstream) {
    diffs.push({ kind: 'rig-error', detail: 'baseline run: mock upstream recorded no request' })
    return { diffs, diagnostics }
  }
  // Baseline self-check: the upstream must have seen exactly the fixture bytes.
  if (baseline.upstream.bodySha256 !== sha256Hex(fixture.request.body)) {
    diffs.push({
      kind: 'rig-error',
      detail: `baseline upstream body sha ${baseline.upstream.bodySha256} != fixture request sha ${sha256Hex(fixture.request.body)} — rig/client bug`,
    })
    return { diffs, diagnostics }
  }
  if (sut.client.timedOut) {
    diffs.push({ kind: 'protocol', side: 'sut', detail: 'SUT run timed out — the SUT hung or swallowed the stream' })
  }
  if (!sut.client.head && !sut.client.timedOut) {
    diffs.push({ kind: 'protocol', side: 'sut', detail: `SUT returned no response head (socketError=${sut.client.socketError ?? 'none'})` })
  }

  // ---- A1 axis: what the upstream saw through the SUT ----
  if (!sut.upstream) {
    diffs.push({ kind: 'protocol', side: 'sut', detail: 'upstream never received a request from the SUT' })
  } else {
    if (sut.upstream.bodySha256 !== sha256Hex(fixture.request.body)) {
      const cmp = diffBytes(fixture.request.body, sut.upstream.body)
      diffs.push({
        kind: 'upstream-request-body-bytes',
        baselineSha256: sha256Hex(fixture.request.body),
        sutSha256: sut.upstream.bodySha256,
        baselineLen: fixture.request.body.length,
        sutLen: sut.upstream.body.length,
        regions: cmp.regions,
        regionsTruncated: cmp.regionsTruncated,
      })
    }
    if (!sut.upstream.bodyComplete) {
      diffs.push({ kind: 'upstream-request-headers', issues: [{ issue: 'request-line-mismatch', name: '(body-completeness)', sutValue: 'upstream did not receive the full declared body' }] })
    }
    const lineIssues: HeaderIssue[] = []
    if (
      sut.upstream.method !== fixture.request.method ||
      sut.upstream.target !== fixture.request.target ||
      sut.upstream.httpVersion !== 'HTTP/1.1'
    ) {
      lineIssues.push({
        issue: 'request-line-mismatch',
        name: '(request-line)',
        baselineValue: `${fixture.request.method} ${fixture.request.target} HTTP/1.1`,
        sutValue: `${sut.upstream.method} ${sut.upstream.target} ${sut.upstream.httpVersion}`,
      })
    }
    lineIssues.push(...compareHeaderPairs(fixture.request.headerPairs, sut.upstream.headerPairs, extraIgnore))
    if (lineIssues.length > 0) diffs.push({ kind: 'upstream-request-headers', issues: lineIssues })
  }

  if (!sut.client.head || !baseline.client.head) return { diffs, diagnostics }

  // ---- response status ----
  const bHead = baseline.client.head
  const sHead = sut.client.head
  if (bHead.statusCode !== sHead.statusCode || (bHead.reason ?? '') !== (sHead.reason ?? '')) {
    diffs.push({
      kind: 'response-status',
      baseline: { code: bHead.statusCode ?? -1, reason: bHead.reason ?? '' },
      sut: { code: sHead.statusCode ?? -1, reason: sHead.reason ?? '' },
    })
  }

  // ---- response headers ----
  const headerIssues = compareHeaderPairs(bHead.headers, sHead.headers, extraIgnore)
  if (headerIssues.length > 0) diffs.push({ kind: 'response-headers', issues: headerIssues })

  // ---- response body bytes ----
  if (baseline.client.bodySha256 !== sut.client.bodySha256) {
    const cmp = diffBytes(baseline.client.body, sut.client.body)
    diffs.push({
      kind: 'response-body-bytes',
      baselineSha256: baseline.client.bodySha256,
      sutSha256: sut.client.bodySha256,
      baselineLen: baseline.client.body.length,
      sutLen: sut.client.body.length,
      regions: cmp.regions,
      regionsTruncated: cmp.regionsTruncated,
    })
  }

  // ---- truncation fidelity ----
  const bTrunc = {
    framingComplete: baseline.client.framingComplete,
    ...(baseline.client.truncatedAtBodyByte !== undefined ? { truncatedAtBodyByte: baseline.client.truncatedAtBodyByte } : {}),
    ...(baseline.client.socketError !== undefined ? { socketError: baseline.client.socketError } : {}),
  }
  const sTrunc = {
    framingComplete: sut.client.framingComplete,
    ...(sut.client.truncatedAtBodyByte !== undefined ? { truncatedAtBodyByte: sut.client.truncatedAtBodyByte } : {}),
    ...(sut.client.socketError !== undefined ? { socketError: sut.client.socketError } : {}),
  }
  if (
    bTrunc.framingComplete !== sTrunc.framingComplete ||
    (bTrunc.truncatedAtBodyByte ?? -1) !== (sTrunc.truncatedAtBodyByte ?? -1)
  ) {
    diffs.push({ kind: 'truncation', baseline: bTrunc, sut: sTrunc })
  }

  // ---- arrival timeline ----
  const nExpected = fixture.response.expectedArrivals.length
  const nBase = baseline.client.bodyEvents.length
  const nSut = sut.client.bodyEvents.length
  if (nExpected > 0 && nBase !== nExpected) {
    if (timing.mode === 'boundaries' && nSut === nBase) {
      // 'boundaries' fixtures use fast, small writes precisely to stress structure
      // at scale; under machine load the kernel may coalesce closely-spaced frames
      // IDENTICALLY on both arms. The structural contract of this mode is
      // sut-structure == baseline-structure (still asserted hard below); the
      // script-realization shortfall is environmental evidence, not a rig error.
      diagnostics.environmentalCoalescing = { expected: nExpected, realized: nBase }
    } else {
      diffs.push({
        kind: 'rig-error',
        detail: `baseline realized ${nBase} body arrivals but the script schedules ${nExpected} — TCP merged segments or the rig mis-decoded; re-run, and if stable, the fixture script needs wider gaps`,
      })
    }
  }

  // ---- §9.7 chunk transit: THE timing gate, single-arm ----
  // Per chunk: client arrival (absolute clock) minus the instant the upstream
  // handed that write to the kernel. The upstream's own scheduler jitter is
  // recorded IN its emit timestamp, so a faithful forwarder is never punished
  // for the mock's hiccups — and a buffering proxy shows up as transit that
  // GROWS across the stream. Applied in every timing mode: it bounds the SUT's
  // added latency, which is cadence-independent.
  //
  // ALIGNMENT RULE (measured, not theoretical): under machine load the kernel
  // may coalesce small closely-spaced frames, so a client can observe FEWER
  // arrivals than the upstream emitted — on BOTH arms identically. Index-
  // aligning in that state compares arrival k against the wrong emit and
  // manufactures phantom multi-ms "transits" (observed: 151 emits → ~100
  // arrivals on both arms → phantom 13–38ms series). So:
  //   - sut arrival structure == baseline arrival structure, but != emits
  //     ⇒ ENVIRONMENTAL coalescing ⇒ align by cumulative BYTES (the emit that
  //       completed each arrival's byte range) — sound under coalescing;
  //   - otherwise ⇒ index alignment — a SUT that coalesces or buffers when the
  //       baseline did not gets its transit measured against the original emit
  //       schedule, which is exactly the growing-transit buffering signature
  //       (BufferingPipe: arrival #0 vs emit #0 ≈ the whole buffered stream).
  const transitOf = (side: RunSide, sameStructureAsBaseline: boolean): number[] => {
    const emits = side.upstream?.emitEvents ?? []
    const arrivals = side.client.bodyEvents
    if (emits.length === 0 || arrivals.length === 0) return []
    const indexAligned = arrivals.length === emits.length || !sameStructureAsBaseline
    const out: number[] = []
    if (indexAligned) {
      const n = Math.min(emits.length, arrivals.length)
      for (let k = 0; k < n; k++) out.push(arrivals[k]!.tAbs - emits[k]!.tAbs)
    } else {
      let j = 0
      for (let k = 0; k < arrivals.length; k++) {
        const cum = arrivals[k]!.cumBytes
        while (j < emits.length - 1 && emits[j]!.cumBytes < cum) j++
        out.push(arrivals[k]!.tAbs - emits[j]!.tAbs)
      }
    }
    return out
  }
  const summarize = (xs: number[]): { samples: number; maxMs: number; meanMs: number } => ({
    samples: xs.length,
    maxMs: xs.length ? round1(Math.max(...xs)) : 0,
    meanMs: xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0,
  })
  const nSutEmits = sut.upstream?.emitEvents.length ?? 0
  const environmentalCoalescing = nSut > 0 && nSut === nBase && nSut !== nSutEmits
  const sutTransit = transitOf(sut, environmentalCoalescing)
  const nBaseEmits = baseline.upstream?.emitEvents.length ?? 0
  const baseTransit = transitOf(baseline, nBase > 0 && nBase === nSut && nBase !== nBaseEmits)
  diagnostics.chunkTransit = {
    ...summarize(sutTransit),
    toleranceMs: timing.gapToleranceMs,
    spikes: sutTransit.filter((t) => Math.abs(t) > timing.gapToleranceMs).length,
    alignment: environmentalCoalescing ? 'cumulative' : 'index',
    emits: nSutEmits,
  }
  diagnostics.baselineTransit = summarize(baseTransit)
  {
    let transitDiffs = 0
    for (let k = 0; k < sutTransit.length && transitDiffs < MAX_GAP_DIFFS; k++) {
      const t = sutTransit[k]!
      if (Math.abs(t) > timing.gapToleranceMs) {
        diffs.push({
          kind: 'chunk-transit',
          index: k,
          emitToArrivalMs: round1(t),
          toleranceMs: timing.gapToleranceMs,
          emittedBytes: sut.upstream?.emitEvents[k]?.bytes ?? -1,
          arrivedBytes: sut.client.bodyEvents[k]?.bytes ?? -1,
        })
        transitDiffs++
      }
    }
  }

  if (timing.mode === 'strict' || timing.mode === 'boundaries') {
    if (nSut !== nBase) {
      diffs.push({
        kind: 'arrival-count',
        classification: nSut < nBase ? 'coalesced' : 'split',
        expected: nExpected,
        baseline: nBase,
        sut: nSut,
      })
    }
    const n = Math.min(nBase, nSut)
    let boundaryDiffs = 0
    for (let k = 0; k < n && boundaryDiffs < MAX_BOUNDARY_DIFFS; k++) {
      const cb = baseline.client.bodyEvents[k]!.cumBytes
      const cs = sut.client.bodyEvents[k]!.cumBytes
      if (cb !== cs) {
        diffs.push({
          kind: 'arrival-boundary',
          index: k,
          offset: Math.min(cb, cs),
          baselineBytes: baseline.client.bodyEvents[k]!.bytes,
          sutBytes: sut.client.bodyEvents[k]!.bytes,
        })
        boundaryDiffs++
      }
    }
  } else {
    // loose: only detect buffering-to-completion (the failure loose mode still must catch)
    if (nBase > 1 && nSut <= 1) {
      diffs.push({ kind: 'arrival-count', classification: 'coalesced', expected: nExpected, baseline: nBase, sut: nSut })
    }
  }

  // ---- gap DIAGNOSTICS (§9.7: printed every run, gate nothing) ----
  // Under machine load the mock upstream's own arm jitters, and a faithful
  // forwarder inherits that jitter honestly — so paired and nominal gap
  // comparisons are evidence about the ENVIRONMENT, not verdicts on the SUT.
  // They must stay visible: a diagnostic that stops being printed is a
  // measurement that quietly stopped existing.
  {
    const gapsB = gapsOf(baseline)
    const gapsS = gapsOf(sut)
    const n = Math.min(gapsB.length, gapsS.length)
    const baseDevs: number[] = []
    const nomDevs: number[] = []
    for (let k = 1; k < n; k++) {
      baseDevs.push(gapsS[k]! - gapsB[k]!)
      const nominal = fixture.response.expectedArrivals[k]?.nominalGapMs
      if (nominal !== undefined) nomDevs.push(gapsS[k]! - nominal)
    }
    const devStats = (xs: number[]): { samples: number; maxAbsDevMs: number; meanDevMs: number } => ({
      samples: xs.length,
      maxAbsDevMs: xs.length ? round1(Math.max(...xs.map(Math.abs))) : 0,
      meanDevMs: xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0,
    })
    diagnostics.gapVsBaseline = devStats(baseDevs)
    diagnostics.gapVsNominal = devStats(nomDevs)
  }

  // ---- TTFB (all modes) ----
  if (baseline.client.ttfbMs !== undefined && sut.client.ttfbMs !== undefined) {
    const delta = sut.client.ttfbMs - baseline.client.ttfbMs
    if (delta > timing.ttfbBudgetMs) {
      diffs.push({
        kind: 'ttfb',
        baselineMs: round1(baseline.client.ttfbMs),
        sutMs: round1(sut.client.ttfbMs),
        deltaMs: round1(delta),
        budgetMs: timing.ttfbBudgetMs,
      })
    }
  }

  return { diffs, diagnostics }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

let shaCache: { buf: Buffer; hex: string } | undefined
function sha256Hex(buf: Buffer): string {
  // Tiny single-entry cache: the fixture body sha is requested on both axes per run.
  if (shaCache && shaCache.buf === buf) return shaCache.hex
  const hex = createHash('sha256').update(buf).digest('hex')
  shaCache = { buf, hex }
  return hex
}
