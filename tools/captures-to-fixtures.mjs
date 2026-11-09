#!/usr/bin/env node
/**
 * Convert recorded V0a captures into rig fixtures (provenance: 'captured').
 *
 * Output goes to fixtures/captured/ — a SEPARATE corpus directory with its own
 * manifest, because fixtures/corpus/ is generated exclusively by
 * tools/build-fixtures.mjs and its --check mode rejects foreign entries. The rig
 * loads either directory via loadCorpus(dir).
 *
 * Pipeline per capture (all transformations are byte-preserving on the body):
 *   request:  raw head bytes -> method/target/ordered header pairs; raw body ->
 *             request.bin. REDACTED for check-in (credentials scrubbed); the raw
 *             capture stays untouched outside git (I2).
 *   response: raw wire -> deframed with the rig's independent decoder ->
 *             status/reason/headers + body; body re-chunked into scripted writes
 *             using the RECORDED arrival boundaries, with recorded delays.
 *
 * Two honest re-stagings, both recorded in the fixture notes:
 *   1. Arrivals closer than MIN_GAP_MS are merged into one write and delays are
 *      floored at MIN_GAP_MS. Real providers emit bursts the loopback mock cannot
 *      reproduce deterministically (sub-millisecond gaps coalesce innocently in
 *      TCP and would trip the rig's expected-arrival check). Merging preserves
 *      body bytes and their order exactly — only the delivery granularity is
 *      normalised, and the fixture says so.
 *   2. Content-length headers are recomputed after redaction (redaction changes
 *      byte counts by design).
 *
 * Captures with status incomplete:client-aborted are SKIPPED (the upstream side
 * of the exchange is not fully known); incomplete:upstream-aborted convert to
 * truncation fixtures (destroy-after-body-bytes at the recorded offset).
 *
 * Usage:
 *   node tools/captures-to-fixtures.mjs [--captures DIR] [--out fixtures/captured]
 *                                       [--ids id1,id2] [--dry-run]
 * Requires: pnpm --filter @observer/rig build && pnpm --filter @observer/capture build
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIN_GAP_MS = 10

let rig, capture
try {
  rig = await import(new URL('../packages/rig/dist/index.js', import.meta.url).href)
  capture = await import(new URL('../packages/capture/dist/index.js', import.meta.url).href)
} catch {
  console.error('captures-to-fixtures: build the rig and capture packages first:\n  pnpm --filter @observer/rig build && pnpm --filter @observer/capture build')
  process.exit(1)
}
const { ResponseDecoder, sha256 } = rig
const { redactHeadBytes, redactBodyBytes, findHead } = capture

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const DRY = process.argv.includes('--dry-run')
const CAPTURES_DIR = path.resolve(arg('captures', path.join(ROOT, 'observer-data', 'captures')))
const OUT_DIR = path.resolve(arg('out', path.join(ROOT, 'fixtures', 'captured')))
const ONLY_IDS = arg('ids', '') ? arg('ids', '').split(',').map((s) => s.trim()) : null

// ---------------------------------------------------------------------------

/** Parse a raw request head into method/target/ordered pairs. */
function parseRequestHead(raw) {
  const parsed = findHead(raw)
  if (!parsed) throw new Error('request head did not parse')
  const [method, target, httpVersion] = parsed.firstLine.split(' ')
  const headers = parsed.headers.map((h) => [
    raw.subarray(h.nameStart, h.nameStart + h.name.length).toString('latin1'),
    raw.subarray(h.valueStart, h.lineEnd).toString('latin1'),
  ])
  return { method, target, httpVersion, headers }
}

/** Deframe a recorded response wire into {statusLine parts, header pairs, body}. */
function deframeWire(wire) {
  const d = new ResponseDecoder()
  const body = d.feed(wire) // single feed returns ALL decoded body bytes for this wire
  d.socketEnded()
  if (!d.head) throw new Error('response wire has no parseable head')
  return {
    status: d.head.statusCode,
    reason: d.head.reason ?? '',
    headers: d.head.headers,
    body,
    complete: d.outcome === 'complete',
    decodedBytes: d.bodyByteCount,
  }
}

/**
 * Re-chunk the decoded body into scripted writes using recorded arrival
 * boundaries, merging arrivals closer than MIN_GAP_MS and flooring delays.
 */
function writesFromArrivals(body, arrivals) {
  const writes = []
  let pending = Buffer.alloc(0)
  let pendingDelay = MIN_GAP_MS
  let prevT = 0
  let prevCum = 0
  for (const a of arrivals) {
    const slice = body.subarray(prevCum, a.cumBytes)
    prevCum = a.cumBytes
    const gap = Math.max(MIN_GAP_MS, Math.round(a.tMs - prevT))
    prevT = a.tMs
    if (pending.length === 0) {
      pending = Buffer.from(slice)
      pendingDelay = gap
    } else if (gap <= MIN_GAP_MS) {
      // burst arrival: merge (documented re-staging #1)
      pending = Buffer.concat([pending, slice])
      pendingDelay = Math.max(pendingDelay, gap)
    } else {
      writes.push({ payload: pending, delayMs: pendingDelay })
      pending = Buffer.from(slice)
      pendingDelay = gap
    }
  }
  if (pending.length > 0) writes.push({ payload: pending, delayMs: pendingDelay })
  return writes
}

function tagsFor(meta, bodyText, isSse) {
  const tags = ['captured']
  if (isSse) tags.push('sse')
  const status = Number((meta.response.statusLine ?? '').split(' ')[1] ?? 0)
  if (status >= 400 && status < 500) tags.push(bodyIsJson(bodyText) ? 'res:4xx-json' : 'res:4xx-nonjson')
  if (status >= 500) tags.push(bodyIsJson(bodyText) ? 'res:5xx-json' : 'res:5xx-nonjson')
  if (!isSse && status > 0 && status < 400) tags.push('res:nonstream')
  if (bodyText.includes('reasoning_content')) tags.push(isSse ? 'res:stream-reasoning-content' : 'res:reasoning-content')
  if (bodyText.includes('obfuscation')) tags.push(isSse ? 'res:stream-obfuscation' : 'res:obfuscation')
  if (bodyText.includes('data: [DONE]')) tags.push('res:stream-done')
  if (meta.status === 'incomplete:upstream-aborted') tags.push('truncation', 'res:stream-abort-mid-chunk')
  const toolIdx = new Set()
  for (const m of bodyText.matchAll(/"index":(\d+),"id":"call_|"index":(\d+),"function"/g)) toolIdx.add(m[1] ?? m[2])
  if (toolIdx.size >= 2) tags.push('res:stream-parallel-tools')
  return [...new Set(tags)]
}
function bodyIsJson(text) {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[')
}

// ---------------------------------------------------------------------------

function convertCapture(captureDir) {
  const meta = JSON.parse(readFileSync(path.join(captureDir, 'meta.json'), 'utf8'))
  const notes = []
  if (meta.status === 'incomplete:client-aborted' || meta.status === 'refused') {
    return { skip: `${meta.captureId}: status ${meta.status} — upstream side not fully observed` }
  }
  if (meta.status === 'incomplete:upstream-connect-failed') {
    return { skip: `${meta.captureId}: upstream never reached — nothing to fixture` }
  }

  // ---- request side ----
  const rawHead = readFileSync(path.join(captureDir, 'request.head.bin'))
  const rawBody = readFileSync(path.join(captureDir, 'request.body.bin'))
  const req = parseRequestHead(rawHead)
  const headRed = redactHeadBytes(rawHead)
  const bodyRed = redactBodyBytes(rawBody)
  if (headRed.redactedHeaders.length) notes.push(`request headers redacted: ${headRed.redactedHeaders.join(', ')}`)
  for (const h of bodyRed.hits) notes.push(`request body redacted: ${h.count}x ${h.kind}`)
  const reqParsedRed = parseRequestHead(headRed.out)
  // content-length must match the (possibly redacted) body
  const headers = reqParsedRed.headers.map(([n, v]) =>
    n.toLowerCase() === 'content-length' ? [n, String(bodyRed.out.length)] : [n, v],
  )

  // ---- response side ----
  const wire = readFileSync(path.join(captureDir, 'response.wire.bin'))
  const wireRed = redactBodyBytes(wire)
  for (const h of wireRed.hits) notes.push(`response wire redacted: ${h.count}x ${h.kind}`)
  let deframed
  try {
    deframed = deframeWire(wireRed.out)
  } catch (err) {
    return { skip: `${meta.captureId}: response wire did not deframe (${err.message})` }
  }
  if (meta.status === 'incomplete:upstream-aborted' && deframed.complete) {
    notes.push('WARNING: meta says truncated but wire deframed complete — inspect capture')
  }
  const isSse = deframed.headers.some(([n, v]) => n.toLowerCase() === 'content-type' && v.includes('text/event-stream'))
  const framing = deframed.headers.some(([n]) => n.toLowerCase() === 'transfer-encoding') ? 'chunked' : 'length'

  // Arrival-scaled writes from the DECODED body (meta arrivals count decoded body bytes)
  const arrivals = meta.response.arrivals ?? []
  let writes
  if (arrivals.length > 0) {
    // Meta arrivals were recorded against the RAW wire (framing included); the
    // decoded body may be shorter. Scale arrival boundaries proportionally when
    // they exceed the decoded length, and clamp — honesty over precision: the
    // fixture notes record that granularity is approximate for chunked streams.
    const decodedLen = deframed.body.length
    const scale = deframed.decodedBytes > 0 ? decodedLen / deframed.decodedBytes : 1
    const scaled = arrivals.map((a) => ({ tMs: a.tMs, cumBytes: Math.min(decodedLen, Math.round(a.cumBytes * scale)) }))
    // de-dupe cumulative offsets that collapsed under scaling
    const dedup = []
    let lastCum = 0
    for (const a of scaled) {
      if (a.cumBytes > lastCum) {
        dedup.push(a)
        lastCum = a.cumBytes
      }
    }
    if (framing === 'chunked') notes.push('response write granularity approximated from raw-wire arrivals (chunk framing bytes excluded from decoded body)')
    writes = writesFromArrivals(deframed.body, dedup)
  } else {
    writes = [{ payload: deframed.body, delayMs: MIN_GAP_MS }]
  }
  if (writes.length === 0) {
    return { skip: `${meta.captureId}: no writable response body arrivals` }
  }

  const resHeaders = deframed.headers.filter(([n]) => !['transfer-encoding', 'content-length', 'connection'].includes(n.toLowerCase()))
  resHeaders.push(['connection', 'close'])

  const terminate = !deframed.complete
    ? { kind: 'destroy-after-body-bytes', bodyBytes: deframed.body.length }
    : undefined

  const fixtureJson = {
    id: `cap-${meta.captureId.replace(/^cap-/, '')}`,
    title: `Captured ${req.method} ${req.target} -> ${meta.response.statusLine ?? '?'} (${meta.status})`,
    provenance: 'captured',
    tags: tagsFor(meta, deframed.body.toString('utf8'), isSse),
    notes:
      `Derived from live capture ${meta.captureId} (upstream ${meta.upstream.origin}). REDACTED copy — the raw capture remains the append-only truth outside git. ` +
      (notes.length ? `Transformations: ${notes.join('; ')}. ` : '') +
      `Delays floored/merged at ${MIN_GAP_MS}ms (see tools/captures-to-fixtures.mjs header).`,
    request: { method: req.method, target: req.target, headers },
    response: {
      status: deframed.status,
      reason: deframed.reason,
      headers: resHeaders,
      framing,
      writes: writes.map((w, i) => ({ payload: { file: `response.${String(i).padStart(3, '0')}.bin` }, delayMs: w.delayMs })),
      ...(terminate ? { terminate } : {}),
    },
    timing: { mode: 'loose' }, // real-world gaps are irregular; identity is the point
  }

  return { fixtureJson, requestBin: bodyRed.out, responseBins: writes.map((w) => w.payload), id: fixtureJson.id }
}

function main() {
  if (!existsSync(CAPTURES_DIR)) {
    console.error(`captures dir not found: ${CAPTURES_DIR}`)
    console.error('Run a live capture first (packages/capture/README.md) or point --captures at a capture store.')
    process.exit(1)
  }
  const dirs = readdirSync(CAPTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (ONLY_IDS === null || ONLY_IDS.includes(d.name)))
    .map((d) => d.name)
    .sort()

  const converted = []
  const skipped = []
  for (const name of dirs) {
    const dir = path.join(CAPTURES_DIR, name)
    if (!existsSync(path.join(dir, 'meta.json'))) {
      skipped.push(`${name}: no meta.json (interrupted capture — suspect, never fixture)`)
      continue
    }
    let result
    try {
      result = convertCapture(dir)
    } catch (err) {
      skipped.push(`${name}: conversion error: ${err.message}`)
      continue
    }
    if (result.skip) {
      skipped.push(result.skip)
      continue
    }
    converted.push(result)
  }

  console.log(`captures scanned: ${dirs.length}; convertible: ${converted.length}; skipped: ${skipped.length}`)
  for (const s of skipped) console.log(`  SKIP ${s}`)

  if (DRY || converted.length === 0) {
    if (converted.length === 0) console.log('nothing to write.')
    return
  }

  // Write fixtures + manifest (same integrity contract as the synthetic corpus).
  mkdirSync(OUT_DIR, { recursive: true })
  const manifestFixtures = []
  for (const c of converted) {
    const dir = path.join(OUT_DIR, c.id)
    mkdirSync(dir, { recursive: true })
    const files = {}
    const put = (name, buf) => {
      writeFileSync(path.join(dir, name), buf)
      files[name] = { sha256: sha256(buf), bytes: buf.length }
    }
    // request body file + inline request in fixture.json
    put('request.bin', c.requestBin)
    c.responseBins.forEach((b, i) => put(`response.${String(i).padStart(3, '0')}.bin`, b))
    const fx = {
      ...c.fixtureJson,
      request: { ...c.fixtureJson.request, body: { file: 'request.bin' } },
    }
    const fxBytes = Buffer.from(`${JSON.stringify(fx, null, 2)}\n`, 'utf8')
    put('fixture.json', fxBytes)
    manifestFixtures.push({ id: c.id, dir: c.id, files })
  }
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify({ version: 1, fixtures: manifestFixtures }, null, 2)}\n`)
  console.log(`wrote ${converted.length} captured fixture(s) to ${path.relative(ROOT, OUT_DIR)}/ + manifest.json`)
  console.log('Load with: loadCorpus("fixtures/captured") — review every fixture for sensitive content BEFORE committing (task-2 privacy note).')
}

main()
