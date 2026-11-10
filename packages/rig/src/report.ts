/**
 * Human-readable formatting of fidelity reports.
 *
 * WHY THIS EXISTS: a diff that says "bodies differ" is worthless for diagnosis and
 * invites the exact failure this project is named after — asserting a problem (or its
 * absence) without showing the evidence. Every diff kind renders with offsets,
 * lengths, and byte excerpts so a failing run explains itself in the CI log.
 */

import type { ByteRegion, FidelityDiff, FidelityRunReport, HeaderIssue, RunSide } from './types.js'

const SHA_LEN = 12

function sha(s: string): string {
  return s.slice(0, SHA_LEN)
}

function ms(x: number): string {
  return `${x.toFixed(1)}ms`
}

export function formatRegions(regions: ByteRegion[], regionsTruncated: boolean, indent = '      '): string {
  const out: string[] = []
  regions.forEach((r, i) => {
    out.push(
      `${indent}region ${i + 1}/${regions.length}${regionsTruncated && i === regions.length - 1 ? ' (list truncated)' : ''} @ offset ${r.offset} (0x${r.offset.toString(16)}) op=${r.op} baseline=${r.baseline.len}B sut=${r.sut.len}B`,
    )
    if (r.baseline.len > 0) {
      out.push(`${indent}  baseline hex : ${r.baseline.hex}`)
      out.push(`${indent}  baseline text: ${JSON.stringify(r.baseline.ascii)}`)
    }
    if (r.sut.len > 0) {
      out.push(`${indent}  sut hex      : ${r.sut.hex}`)
      out.push(`${indent}  sut text     : ${JSON.stringify(r.sut.ascii)}`)
    }
  })
  if (regions.length === 0) out.push(`${indent}(no regions located — bodies differ by hash only; this is a diff-scan limitation, not an equality claim)`)
  return out.join('\n')
}

export function formatHeaderIssues(issues: HeaderIssue[], indent = '      '): string {
  return issues
    .map((h) => {
      const pos = h.baselinePosition !== undefined || h.sutPosition !== undefined ? ` @pos baseline=${h.baselinePosition ?? '-'} sut=${h.sutPosition ?? '-'}` : ''
      const vals =
        h.issue === 'value-mismatch' || h.issue === 'request-line-mismatch' || h.issue === 'reordered'
          ? ` baseline=${JSON.stringify(h.baselineValue)} sut=${JSON.stringify(h.sutValue)}`
          : h.issue === 'missing'
            ? ` baseline=${JSON.stringify(h.baselineValue)}`
            : ` sut=${JSON.stringify(h.sutValue)}`
      return `${indent}${h.issue}: ${h.name}${pos}${vals}`
    })
    .join('\n')
}

export function formatTimeline(side: RunSide, indent = '      ', maxEvents = 24): string {
  const ev = side.client.bodyEvents
  const rows: string[] = []
  let prev = 0
  for (let k = 0; k < Math.min(ev.length, maxEvents); k++) {
    const e = ev[k]!
    rows.push(`${indent}#${String(k).padStart(2)} t=${ms(e.tMs).padStart(9)} gap=${ms(e.tMs - prev).padStart(9)} bytes=${String(e.bytes).padStart(7)} cum=${e.cumBytes}`)
    prev = e.tMs
  }
  if (ev.length > maxEvents) rows.push(`${indent}... ${ev.length - maxEvents} more arrivals`)
  rows.push(`${indent}ttfb=${side.client.ttfbMs !== undefined ? ms(side.client.ttfbMs) : '-'} framingComplete=${side.client.framingComplete} truncatedAt=${side.client.truncatedAtBodyByte ?? '-'} total=${ms(side.client.totalMs)}`)
  return rows.join('\n')
}

export function formatDiff(d: FidelityDiff, index: number): string {
  const head = `  [${index + 1}] ${d.kind}`
  switch (d.kind) {
    case 'response-status':
      return `${head}: baseline=${d.baseline.code} ${JSON.stringify(d.baseline.reason)} sut=${d.sut.code} ${JSON.stringify(d.sut.reason)}`
    case 'response-headers':
      return `${head}: ${d.issues.length} issue(s)\n${formatHeaderIssues(d.issues)}`
    case 'response-body-bytes':
    case 'upstream-request-body-bytes':
      return [
        `${head}: sha256 baseline=${sha(d.baselineSha256)} sut=${sha(d.sutSha256)} lengths ${d.baselineLen} vs ${d.sutLen}`,
        formatRegions(d.regions, d.regionsTruncated),
      ].join('\n')
    case 'upstream-request-headers':
      return `${head}: ${d.issues.length} issue(s)\n${formatHeaderIssues(d.issues)}`
    case 'arrival-count':
      return `${head}: ${d.classification} — expected ${d.expected} arrival(s), baseline ${d.baseline}, sut ${d.sut}`
    case 'arrival-boundary':
      return `${head}: arrival #${d.index} boundary at body offset ${d.offset}: baseline delivered ${d.baselineBytes}B here, sut ${d.sutBytes}B`
    case 'chunk-transit':
      return `${head}: chunk #${d.index} arrived ${ms(d.emitToArrivalMs)} after the upstream emitted it (tolerance ${ms(d.toleranceMs)}; emitted ${d.emittedBytes}B, arrived ${d.arrivedBytes}B) — a GROWING series across chunks is the buffering signature`
    case 'arrival-gap':
      return `${head}: arrival #${d.index} gap baseline=${ms(d.baselineGapMs)} sut=${ms(d.sutGapMs)}${d.nominalGapMs !== undefined ? ` nominal=${ms(d.nominalGapMs)}` : ''} tolerance=${ms(d.toleranceMs)} (versus ${d.versus})`
    case 'ttfb':
      return `${head}: baseline=${ms(d.baselineMs)} sut=${ms(d.sutMs)} delta=${ms(d.deltaMs)} budget=${ms(d.budgetMs)}`
    case 'truncation':
      return `${head}: baseline complete=${d.baseline.framingComplete} truncatedAt=${d.baseline.truncatedAtBodyByte ?? '-'} err=${d.baseline.socketError ?? '-'} | sut complete=${d.sut.framingComplete} truncatedAt=${d.sut.truncatedAtBodyByte ?? '-'} err=${d.sut.socketError ?? '-'}`
    case 'protocol':
      return `${head} (${d.side}): ${d.detail}`
    case 'rig-error':
      return `${head}: ${d.detail}`
  }
}

/**
 * Timing diagnostics (§9.7): printed EVERY run — passing or failing. The gate is
 * chunk-transit; the gap comparisons are environmental evidence. A diagnostic
 * that stops being printed is a measurement that quietly stopped existing.
 */
export function formatDiagnostics(r: FidelityRunReport): string {
  const d = r.diagnostics
  const lines = [
    `    timing diagnostics (gate = chunk-transit ≤ ${d.chunkTransit.toleranceMs}ms [${d.chunkTransit.alignment}-aligned, ${d.chunkTransit.emits} emits, spikes=${d.chunkTransit.spikes}]; gap axes are evidence, not verdicts):`,
    `      chunk-transit sut : n=${d.chunkTransit.samples} mean=${d.chunkTransit.meanMs}ms max=${d.chunkTransit.maxMs}ms`,
    `      chunk-transit base: n=${d.baselineTransit.samples} mean=${d.baselineTransit.meanMs}ms max=${d.baselineTransit.maxMs}ms (loopback noise floor)`,
    `      gap vs baseline   : n=${d.gapVsBaseline.samples} meanDev=${d.gapVsBaseline.meanDevMs}ms maxAbsDev=${d.gapVsBaseline.maxAbsDevMs}ms`,
    `      gap vs nominal    : n=${d.gapVsNominal.samples} meanDev=${d.gapVsNominal.meanDevMs}ms maxAbsDev=${d.gapVsNominal.maxAbsDevMs}ms`,
  ]
  if (d.environmentalCoalescing) {
    lines.push(
      `      environmental coalescing: baseline realized ${d.environmentalCoalescing.realized}/${d.environmentalCoalescing.expected} scheduled arrivals; sut mirrored baseline exactly (structural comparison still gated)`,
    )
  }
  return lines.join('\n')
}

export function formatReport(r: FidelityRunReport, opts: { timelines?: boolean } = {}): string {
  const lines: string[] = []
  const verdict = r.passed ? 'PASSED (0 diffs)' : `FAILED (${r.diffs.length} diff${r.diffs.length === 1 ? '' : 's'})`
  lines.push(`fixture ${r.fixtureId} vs SUT "${r.sutName}" — ${verdict} [${r.durationMs.toFixed(0)}ms]`)
  r.diffs.forEach((d, i) => lines.push(formatDiff(d, i)))
  lines.push(formatDiagnostics(r))
  if (opts.timelines && !r.passed) {
    lines.push('    baseline arrival timeline:')
    lines.push(formatTimeline(r.baseline))
    lines.push('    sut arrival timeline:')
    lines.push(formatTimeline(r.sut))
  }
  return lines.join('\n')
}
