/**
 * Latency benchmark harness — the measurement side of V1/A7 ("added latency
 * p50 < 15 ms, p99 < 40 ms on the no-policy path, measured by the rig over
 * >=1000 requests") and V4b's TTFB criterion at statistic scale.
 *
 * Methodology choices, stated because they determine what the numbers mean:
 *  - ALTERNATING paired runs (direct, SUT, direct, SUT, ...): each SUT sample is
 *    paired with a direct sample taken milliseconds earlier, so machine-level
 *    drift (thermals, background load) largely cancels in the delta instead of
 *    inflating it.
 *  - Sequential requests (concurrency 1): A7 budgets the latency a single agent
 *    experiences on the no-policy path, not throughput under load.
 *  - Warmup samples are collected but EXCLUDED from stats (JIT, connection
 *    machinery, file-system caches).
 *  - Stats are nearest-rank percentiles over the paired deltas: delta = SUT -
 *    direct per request index. Single-shot thresholds flake on shared runners;
 *    p50/p99 over >=1000 pairs is what the acceptance criterion actually asks.
 */

import { runClient } from './client.js'
import { startMockUpstream } from './upstream.js'
import type { ResolvedFixture, Sut } from './types.js'

export interface LatencyStats {
  count: number
  min: number
  p50: number
  p90: number
  p99: number
  max: number
  mean: number
}

export interface LatencyBenchmarkOptions {
  fixture: ResolvedFixture
  sut: Sut
  /** Measured requests per arm (direct and SUT). A7 asks for >= 1000. */
  requests: number
  /** Excluded from stats. Default 50. */
  warmup?: number
  /** Per-request watchdog. Default 15_000. */
  clientTimeoutMs?: number
}

export interface LatencyBenchmarkResult {
  requests: number
  warmup: number
  ttfbMs: { direct: LatencyStats; sut: LatencyStats; delta: LatencyStats }
  totalMs: { direct: LatencyStats; sut: LatencyStats; delta: LatencyStats }
  /** Any run that failed protocol sanity (no head, timeout, wrong body sha). */
  anomalies: string[]
}

export function nearestRankPercentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[rank] as number
}

export function statsOf(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: nearestRankPercentile(sorted, 0.5),
    p90: nearestRankPercentile(sorted, 0.9),
    p99: nearestRankPercentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: sorted.length > 0 ? sum / sorted.length : Number.NaN,
  }
}

export async function runLatencyBenchmark(opts: LatencyBenchmarkOptions): Promise<LatencyBenchmarkResult> {
  const warmup = opts.warmup ?? 50
  const timeoutMs = opts.clientTimeoutMs ?? 15_000
  const { fixture } = opts

  const upDirect = await startMockUpstream(fixture.response.script, fixture.response.payloads)
  const upSut = await startMockUpstream(fixture.response.script, fixture.response.payloads)
  const sutHandle = await opts.sut.start({ upstreamOrigin: upSut.origin, upstreamPort: upSut.port })

  const anomalies: string[] = []
  const directTtfb: number[] = []
  const sutTtfb: number[] = []
  const directTotal: number[] = []
  const sutTotal: number[] = []
  const deltaTtfb: number[] = []
  const deltaTotal: number[] = []

  try {
    let baselineSha: string | undefined
    const total = warmup + opts.requests
    for (let i = 0; i < total; i++) {
      const d = await runClient({
        port: upDirect.port,
        headBytes: fixture.request.headBytes,
        body: fixture.request.body,
        timeoutMs,
      })
      const s = await runClient({
        port: sutHandle.port,
        headBytes: fixture.request.headBytes,
        body: fixture.request.body,
        timeoutMs,
      })
      // Protocol sanity on every pair — a latency number from a broken exchange
      // is worse than no number.
      if (!d.head || d.timedOut) anomalies.push(`run ${i}: direct run broken (head=${!!d.head}, timedOut=${d.timedOut})`)
      if (!s.head || s.timedOut) anomalies.push(`run ${i}: sut run broken (head=${!!s.head}, timedOut=${s.timedOut})`)
      if (baselineSha === undefined && d.bodySha256) baselineSha = d.bodySha256
      if (baselineSha !== undefined) {
        if (d.bodySha256 !== baselineSha) anomalies.push(`run ${i}: direct body sha drifted`)
        if (s.bodySha256 !== baselineSha) anomalies.push(`run ${i}: sut body sha differs from direct — latency of a MUTATED response is not the measurement`)
      }
      if (d.ttfbMs === undefined || s.ttfbMs === undefined) {
        anomalies.push(`run ${i}: missing ttfb`)
        continue
      }
      if (i < warmup) continue
      directTtfb.push(d.ttfbMs)
      sutTtfb.push(s.ttfbMs)
      directTotal.push(d.totalMs)
      sutTotal.push(s.totalMs)
      deltaTtfb.push(s.ttfbMs - d.ttfbMs)
      deltaTotal.push(s.totalMs - d.totalMs)
    }
  } finally {
    await sutHandle.stop()
    await upDirect.stop()
    await upSut.stop()
  }

  return {
    requests: opts.requests,
    warmup,
    ttfbMs: { direct: statsOf(directTtfb), sut: statsOf(sutTtfb), delta: statsOf(deltaTtfb) },
    totalMs: { direct: statsOf(directTotal), sut: statsOf(sutTotal), delta: statsOf(deltaTotal) },
    anomalies,
  }
}

/** A7-style budget assertion helper: returns the violations (empty = pass). */
export function checkLatencyBudget(
  result: LatencyBenchmarkResult,
  budget: { deltaTtfbP50MaxMs?: number; deltaTtfbP99MaxMs?: number; deltaTotalP50MaxMs?: number; deltaTotalP99MaxMs?: number },
): string[] {
  const violations: string[] = []
  const d = result.ttfbMs.delta
  const t = result.totalMs.delta
  if (budget.deltaTtfbP50MaxMs !== undefined && !(d.p50 <= budget.deltaTtfbP50MaxMs)) {
    violations.push(`ttfb delta p50 ${d.p50.toFixed(2)}ms > budget ${budget.deltaTtfbP50MaxMs}ms`)
  }
  if (budget.deltaTtfbP99MaxMs !== undefined && !(d.p99 <= budget.deltaTtfbP99MaxMs)) {
    violations.push(`ttfb delta p99 ${d.p99.toFixed(2)}ms > budget ${budget.deltaTtfbP99MaxMs}ms`)
  }
  if (budget.deltaTotalP50MaxMs !== undefined && !(t.p50 <= budget.deltaTotalP50MaxMs)) {
    violations.push(`total delta p50 ${t.p50.toFixed(2)}ms > budget ${budget.deltaTotalP50MaxMs}ms`)
  }
  if (budget.deltaTotalP99MaxMs !== undefined && !(t.p99 <= budget.deltaTotalP99MaxMs)) {
    violations.push(`total delta p99 ${t.p99.toFixed(2)}ms > budget ${budget.deltaTotalP99MaxMs}ms`)
  }
  if (result.anomalies.length > 0) {
    violations.push(`${result.anomalies.length} protocol anomalies during benchmark (first: ${result.anomalies[0]})`)
  }
  return violations
}

export function formatLatencyResult(r: LatencyBenchmarkResult): string {
  const fmt = (s: LatencyStats): string =>
    `n=${s.count} min=${s.min.toFixed(2)} p50=${s.p50.toFixed(2)} p90=${s.p90.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)} mean=${s.mean.toFixed(2)}`
  return [
    `latency benchmark: ${r.requests} measured pairs (+${r.warmup} warmup), anomalies: ${r.anomalies.length}`,
    `  ttfb  direct : ${fmt(r.ttfbMs.direct)}`,
    `  ttfb  sut    : ${fmt(r.ttfbMs.sut)}`,
    `  ttfb  delta  : ${fmt(r.ttfbMs.delta)}`,
    `  total direct : ${fmt(r.totalMs.direct)}`,
    `  total sut    : ${fmt(r.totalMs.sut)}`,
    `  total delta  : ${fmt(r.totalMs.delta)}`,
    ...r.anomalies.slice(0, 5).map((a) => `  ANOMALY ${a}`),
  ].join('\n')
}
