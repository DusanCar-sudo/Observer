/**
 * Smoke tests for the latency benchmark harness (V1/A7's measurement side).
 *
 * These validate the HARNESS, not the SUT's speed: small request counts, and a
 * deliberately loose smoke bound on the ReferencePipe delta (a loose bound still
 * catches a pathological buffering regression; the tight A7 budgets — p50<15ms,
 * p99<40ms over >=1000 requests — are asserted in V1's own acceptance suite
 * where runner conditions are controlled and the number is the deliverable).
 */

import { describe, expect, it } from 'vitest'
import {
  checkLatencyBudget,
  formatLatencyResult,
  loadCorpus,
  nearestRankPercentile,
  runLatencyBenchmark,
  statsOf,
} from '../src/index.js'
import { BufferingPipe } from '../src/testdoubles/faulty.js'
import { ReferencePipe } from '../src/testdoubles/reference-pipe.js'

describe('stats', () => {
  it('nearest-rank percentiles on a known sample', () => {
    const s = statsOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(s.count).toBe(10)
    expect(s.p50).toBe(5)
    expect(s.p99).toBe(10)
    expect(s.mean).toBe(5.5)
    expect(nearestRankPercentile([], 0.5)).toBeNaN()
  })
})

describe('latency benchmark harness', () => {
  it(
    'ReferencePipe: paired stats computed, no anomalies, delta within the loose smoke bound',
    async () => {
      const corpus = await loadCorpus()
      const fixture = corpus.find((f) => f.id === 'res-nonstream-json')!
      const result = await runLatencyBenchmark({ fixture, sut: ReferencePipe, requests: 100, warmup: 10 })
      expect(result.anomalies, formatLatencyResult(result)).toEqual([])
      expect(result.ttfbMs.delta.count).toBe(100)
      expect(result.totalMs.delta.count).toBe(100)
      // sanity: percentiles ordered
      const d = result.ttfbMs.delta
      expect(d.p50).toBeLessThanOrEqual(d.p99)
      // loose smoke bound: a faithful pipe adds one hop, not a buffering stage
      expect(d.p99, formatLatencyResult(result)).toBeLessThan(100)
      // the A7-style budget helper agrees with a loose budget and complains with an absurd one
      expect(checkLatencyBudget(result, { deltaTtfbP99MaxMs: 100 })).toEqual([])
      const absurd = checkLatencyBudget(result, { deltaTtfbP50MaxMs: -50 })
      expect(absurd.length).toBeGreaterThan(0)
      expect(absurd[0]).toMatch(/ttfb delta p50/)
    },
    180_000,
  )

  it(
    'BufferingPipe: the harness surfaces the pathology in the delta stats',
    async () => {
      const corpus = await loadCorpus()
      const fixture = corpus.find((f) => f.id === 'res-nonstream-json')!
      const result = await runLatencyBenchmark({ fixture, sut: BufferingPipe, requests: 30, warmup: 5 })
      // buffering holds the response for the script's delay before ANY byte:
      // the ttfb delta must show it clearly (fixture delay is 10ms)
      expect(result.ttfbMs.delta.p50, formatLatencyResult(result)).toBeGreaterThanOrEqual(5)
      expect(checkLatencyBudget(result, { deltaTtfbP50MaxMs: 1 }).length).toBeGreaterThan(0)
    },
    120_000,
  )
})
