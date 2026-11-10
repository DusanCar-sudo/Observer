/**
 * A7 — ADDED LATENCY, measured not estimated.
 *
 * "p50 < 15 ms, p99 < 40 ms on the no-policy path, measured by the rig over
 * >=1000 requests." Measured with the paired benchmark harness: alternating
 * direct/SUT runs so machine drift cancels per pair, warmup excluded, and — per
 * spec §9.2 — every pair protocol-sanity-checked, because the latency of a
 * mutated response is not a measurement.
 *
 * CI-noise policy (agreed with lead): if a shared runner cannot hold the budget,
 * REPORT the measured numbers — never silently loosen the assertion.
 */

import { describe, expect, it } from 'vitest'
import { checkLatencyBudget, formatLatencyResult, runLatencyBenchmark } from '@observer/rig'
import { fixture, gatewaySut } from './helpers.js'

describe('A7 — added latency budget', () => {
  it(
    'p50 < 15 ms and p99 < 40 ms over 1000 paired requests, zero protocol anomalies',
    async () => {
      const fx = await fixture('res-nonstream-json')
      const result = await runLatencyBenchmark({
        fixture: fx,
        sut: gatewaySut(),
        requests: 1000,
        warmup: 50,
      })
      const violations = checkLatencyBudget(result, {
        deltaTotalP50MaxMs: 15,
        deltaTotalP99MaxMs: 40,
      })
      // On failure, the FULL formatted distribution lands in the CI log — the
      // numbers are the deliverable, not just the verdict.
      expect(violations, `\n${formatLatencyResult(result)}`).toEqual([])
      // TTFB delta reported alongside (V4b will gate it separately at <5ms with
      // streaming fixtures; recorded here so regressions show early).
      expect(result.ttfbMs.delta.p99, formatLatencyResult(result)).toBeLessThan(40)
    },
    300_000,
  )
})
