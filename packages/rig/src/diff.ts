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

  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      i++
      j++
      continue
    }
    // Mismatch run start. Try anchor resync in both directions.
    const anchorB = B.subarray(j, j + ANCHOR_LEN)
    const anchorA = A.subarray(i, i + ANCHOR_LEN)
    let posA = -1
    let posB = -1
    if (anchorB.length === ANCHOR_LEN) posA = A.indexOf(anchorB, i, Math.min(A.length, i + RESYNC_WINDOW))
    if (anchorA.length === ANCHOR_LEN) posB = B.indexOf(anchorA, j, Math.min(B.length, j + RESYNC_WINDOW))

    if (posA !== -1 && (posB === -1 || posA - i <= posB - j)) {
      // Baseline has bytes the sut dropped (sut resyncs at posA).
      pushRegion('delete', i, posA, j, j)
      i = posA
      continue
    }
    if (posB !== -1) {
      // Sut inserted bytes relative to baseline.
      pushRegion('insert', i, i, j, posB)
      j = posB
      continue
    }
    // No resync anchor nearby: emit the remainder of the middle as one replace and stop.
    pushRegion('replace', i, A.length, j, B.length)
    i = A.length
    j = B.length
    break
  }
  if (!truncated && (i < A.length || j < B.length)) {
    if (j >= B.length && i < A.length) pushRegion('delete', i, A.length, j, B.length)
    else if (i >= A.length && j < B.length) pushRegion('insert', i, A.length, j, B.length)
    else pushRegion('replace', i, A.length, j, B.length)
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

export function diffRuns(
  fixture: ResolvedFixture,
  baseline: RunSide,
  sut: RunSide,
  opts: {
    headerIgnore?: readonly string[] | undefined
    timing?: { mode?: 'strict' | 'loose'; gapToleranceMs?: number; ttfbBudgetMs?: number } | undefined
  } = {},
): FidelityDiff[] {
  const diffs: FidelityDiff[] = []
  const extraIgnore = new Set((opts.headerIgnore ?? []).map((n) => n.toLowerCase()))
  const timing = {
    mode: opts.timing?.mode ?? fixture.timing.mode,
    gapToleranceMs: opts.timing?.gapToleranceMs ?? fixture.timing.gapToleranceMs,
    ttfbBudgetMs: opts.timing?.ttfbBudgetMs ?? fixture.timing.ttfbBudgetMs,
  }

  // ---- protocol-level sanity ----
  if (baseline.client.timedOut) {
    diffs.push({ kind: 'rig-error', detail: 'baseline run timed out — fixture script or rig is broken (the direct path must always work)' })
    return diffs
  }
  if (!baseline.client.head) {
    diffs.push({ kind: 'rig-error', detail: `baseline run received no response head (socketError=${baseline.client.socketError ?? 'none'})` })
    return diffs
  }
  if (!baseline.upstream) {
    diffs.push({ kind: 'rig-error', detail: 'baseline run: mock upstream recorded no request' })
    return diffs
  }
  // Baseline self-check: the upstream must have seen exactly the fixture bytes.
  if (baseline.upstream.bodySha256 !== sha256Hex(fixture.request.body)) {
    diffs.push({
      kind: 'rig-error',
      detail: `baseline upstream body sha ${baseline.upstream.bodySha256} != fixture request sha ${sha256Hex(fixture.request.body)} — rig/client bug`,
    })
    return diffs
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

  if (!sut.client.head || !baseline.client.head) return diffs

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
    diffs.push({
      kind: 'rig-error',
      detail: `baseline realized ${nBase} body arrivals but the script schedules ${nExpected} — TCP merged segments or the rig mis-decoded; re-run, and if stable, the fixture script needs wider gaps`,
    })
  }
  if (timing.mode === 'strict') {
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
    const gapsB = gapsOf(baseline)
    const gapsS = gapsOf(sut)
    let gapDiffs = 0
    // k=0 is the gap from request-written to first body byte: it carries upload time
    // and per-hop latency, which the TTFB axis budgets separately. The inter-chunk
    // fidelity signal (V4b's "client must observe the same intervals") lives in k>=1.
    for (let k = 1; k < n && gapDiffs < MAX_GAP_DIFFS; k++) {
      const gb = gapsB[k]!
      const gs = gapsS[k]!
      if (Math.abs(gs - gb) > timing.gapToleranceMs) {
        diffs.push({
          kind: 'arrival-gap',
          index: k,
          baselineGapMs: round1(gb),
          sutGapMs: round1(gs),
          toleranceMs: timing.gapToleranceMs,
          versus: 'baseline',
        })
        gapDiffs++
      }
      const nominal = fixture.response.expectedArrivals[k]?.nominalGapMs
      if (nominal !== undefined && Math.abs(gs - nominal) > timing.gapToleranceMs) {
        diffs.push({
          kind: 'arrival-gap',
          index: k,
          baselineGapMs: round1(gb),
          sutGapMs: round1(gs),
          nominalGapMs: nominal,
          toleranceMs: timing.gapToleranceMs,
          versus: 'nominal',
        })
        gapDiffs++
      }
    }
  } else {
    // loose: only detect buffering-to-completion (the failure loose mode still must catch)
    if (nBase > 1 && nSut <= 1) {
      diffs.push({ kind: 'arrival-count', classification: 'coalesced', expected: nExpected, baseline: nBase, sut: nSut })
    }
  }

  // ---- TTFB (both modes) ----
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

  return diffs
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
