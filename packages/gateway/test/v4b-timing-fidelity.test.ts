/**
 * V4b — SSE INCREMENTAL DELIVERY AND INTER-CHUNK TIMING.
 *
 * Acceptance (task-7): TTFB delta vs direct < 5 ms; one event per TCP write at
 * 50 ms intervals observed within ±5 ms; no coalescing; no buffering-to-
 * completion; inter-chunk gaps measured, not just final bytes.
 *
 * ASSERTION SHAPE (lead-approved; spec §9.5 TTFB, §9.7 gaps, §9.8 capture cost):
 *
 *  TTFB — four arms in ONE interleaved session with rotating arm order
 *  (bench/v4b-timing.mjs): direct | gateway capture-OFF | gateway capture-ON
 *  (shipping config) | ReferencePipe, all deltas against the SAME direct run.
 *   - GATE A (hard, forwarding fidelity): p99(capture-off − direct) ≤
 *     p99(ReferencePipe − direct), same session, never cached. ReferencePipe is
 *     a fidelity double WITHOUT a recorder; comparing capture-ON against it
 *     would conflate forwarding overhead with recording cost.
 *   - GATE B (hard, capture cost): p50(capture-on) − p50(capture-off) ≤ 1.5 ms.
 *     DERIVATION OF 1.5 (not an invented margin): measured capture-cost delta
 *     ≈ 0.9 ms p50 in the three-arm decomposition (2026-11-10: on 1.47 / off
 *     0.57), rounded up for machine variance. p50, not p99, because the cost is
 *     structural (mkdirSync + first writes on the exchange-start path) and the
 *     median tracks structural cost; a p99 gate would reintroduce the noise
 *     sensitivity §9.7 removed. END STATE (task-4): V2's write-behind spool must
 *     reach delta ≤ 0.3 ms, then Gate A is re-run with capture ON and Gate B is
 *     RETIRED. A temporary gate without a removal condition is a permanent gate
 *     with an apology.
 *   - ABSOLUTE p50 < 5 ms on the SHIPPING configuration (capture-on): the
 *     criterion's own number; the reference-relative logic deliberately does NOT
 *     creep onto the median (lead constraint).
 *   - §9.2: every arm's body sha checked every iteration; anomalies invalidate.
 *
 *  GAPS — the §9.7 gate is per-chunk `arrival − emit` ≤ 5 ms, asserted HARD by
 *  the rig's chunk-transit axis inside every runFidelityCheck of the 50 ms
 *  spec-shaped fixture across 25 runs. Single-arm: the upstream timestamps its
 *  own writes, so the mock's scheduler jitter lands in the emit timestamp and a
 *  faithful forwarder is never punished for it. Buffering trips this axis as a
 *  ~350 ms transit on arrival #0 (proven by the rig's BufferingPipe detection
 *  test). Under kernel coalescing identical on both arms, transit falls back to
 *  cumulative-byte alignment and the report says so — a green run under heavy
 *  coalescing is visibly a weaker test than a clean one (lead condition).
 *  Gap-vs-nominal and gap-vs-baseline deviations are EVIDENCE, printed every
 *  run, gated nowhere.
 *
 * KEEPALIVE (lead constraint): nothing emits `: keepalive` or any undocumented
 * token into a supervised stream; the round-2 [ASSUMPTION] downgrade stands.
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

interface Stats {
  count?: number
  n?: number
  min: number
  max: number
  absMax?: number
  p50?: number
  p90?: number
  p99?: number
  mean: number
}

interface GateA {
  pass: boolean
  gwOffP99: number
  referenceP99: number
}
interface GateB {
  pass: boolean
  deltaMs: number
  budgetMs: number
}
interface GateAbs {
  pass: boolean
  gwOnP50: number
  budgetMs: number
}

interface BenchEvidence {
  ttfb: {
    pairs: number
    warmup: number
    anomalies: number
    anomalySample: string[]
    gatewayOffDelta: Stats
    gatewayOnDelta: Stats
    referenceDelta: Stats
    directTtfb: Stats
    gatewayOnStats: Record<string, unknown>
    gates: {
      A_forwardingFidelity: GateA
      B_captureCostP50: GateB
      absoluteP50Shipping: GateAbs
    }
  }
  gaps: {
    runs: number
    toleranceMs: number
    gapSamples: number
    transitMaxMs: number
    nominalDeviations: Stats
    pairedDeviations: Stats
    holdbackMeanMs: number
    violations: string[]
  }
}

function runHarness(): Promise<BenchEvidence> {
  return new Promise((resolve, reject) => {
    const script = path.join(import.meta.dirname, '..', 'bench', 'v4b-timing.mjs')
    execFile(process.execPath, [script], { maxBuffer: 64 * 1024 * 1024, timeout: 900_000 }, (err, stdout, stderr) => {
      if (stderr) process.stderr.write(stderr) // evidence to the CI log, every run
      if (err) {
        reject(new Error(`v4b harness failed: ${err.message}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as BenchEvidence)
      } catch (e) {
        reject(new Error(`v4b harness output not JSON: ${String(e)}\n${stdout.slice(0, 2000)}`))
      }
    })
  })
}

describe('V4b — timing fidelity (clean-process, four-arm measurement)', () => {
  it(
    'Gate A: capture-off p99 <= ReferencePipe p99 (same session) | Gate B: capture cost p50 <= 1.5ms | shipping p50 < 5ms absolute | per-chunk transit <=5ms hard over 25 runs',
    async () => {
      const ev = await runHarness()
      const evidence = JSON.stringify(ev, null, 2)

      // ---- §9.2 protocol sanity first: a mutated response is not a measurement ----
      expect(ev.ttfb.pairs).toBeGreaterThanOrEqual(400)
      expect(ev.ttfb.anomalies, `protocol anomalies invalidate the measurement:\n${evidence}`).toBe(0)

      // ---- GATE A: forwarding fidelity, reference-relative tail, same session ----
      expect(
        ev.ttfb.gates.A_forwardingFidelity.pass,
        `Gate A: gateway(capture-off) p99 ${ev.ttfb.gates.A_forwardingFidelity.gwOffP99.toFixed(2)}ms must not exceed same-session ReferencePipe p99 ${ev.ttfb.gates.A_forwardingFidelity.referenceP99.toFixed(2)}ms:\n${evidence}`,
      ).toBe(true)

      // ---- GATE B: capture cost at p50, budget 1.5ms (derived: ~0.9ms measured + variance headroom; retired when V2 spool lands at <=0.3ms) ----
      expect(
        ev.ttfb.gates.B_captureCostP50.pass,
        `Gate B: capture cost p50 delta ${ev.ttfb.gates.B_captureCostP50.deltaMs.toFixed(2)}ms exceeds ${ev.ttfb.gates.B_captureCostP50.budgetMs}ms — recording is becoming a latency tax; V2's write-behind spool owns this number:\n${evidence}`,
      ).toBe(true)

      // ---- ABSOLUTE p50 on the shipping configuration ----
      expect(
        ev.ttfb.gates.absoluteP50Shipping.pass,
        `shipping-config p50 ${ev.ttfb.gates.absoluteP50Shipping.gwOnP50.toFixed(2)}ms must stay under the absolute ${ev.ttfb.gates.absoluteP50Shipping.budgetMs}ms:\n${evidence}`,
      ).toBe(true)

      // ---- GAPS: the rig's chunk-transit axis gated every run; violations = rig diffs ----
      // (violations checked first so a failing run reports WHY, not just the sample shortfall)
      expect(ev.gaps.violations, `chunk-transit/structure violations:\n${evidence}`).toEqual([])
      expect(ev.gaps.gapSamples).toBeGreaterThanOrEqual(ev.gaps.runs * 7)
      expect(ev.gaps.transitMaxMs).toBeLessThanOrEqual(5)

      // ---- evidence for the record (printed every run, gates nothing) ----
      // eslint-disable-next-line no-console
      console.log(
        [
          '[V4b summary]',
          `  gate A  gw-off p99=${ev.ttfb.gates.A_forwardingFidelity.gwOffP99.toFixed(2)}ms <= ref p99=${ev.ttfb.gates.A_forwardingFidelity.referenceP99.toFixed(2)}ms : ${ev.ttfb.gates.A_forwardingFidelity.pass ? 'PASS' : 'FAIL'}`,
          `  gate B  capture cost p50 delta=${ev.ttfb.gates.B_captureCostP50.deltaMs.toFixed(2)}ms <= ${ev.ttfb.gates.B_captureCostP50.budgetMs}ms : ${ev.ttfb.gates.B_captureCostP50.pass ? 'PASS' : 'FAIL'} (retires when V2 spool reaches <=0.3ms)`,
          `  abs p50 shipping (capture-on) = ${ev.ttfb.gates.absoluteP50Shipping.gwOnP50.toFixed(2)}ms < ${ev.ttfb.gates.absoluteP50Shipping.budgetMs}ms : ${ev.ttfb.gates.absoluteP50Shipping.pass ? 'PASS' : 'FAIL'}`,
          `  arms    gwOff p50/p99=${ev.ttfb.gatewayOffDelta.p50!.toFixed(2)}/${ev.ttfb.gatewayOffDelta.p99!.toFixed(2)}ms  gwOn p50/p99=${ev.ttfb.gatewayOnDelta.p50!.toFixed(2)}/${ev.ttfb.gatewayOnDelta.p99!.toFixed(2)}ms  ref p50/p99=${ev.ttfb.referenceDelta.p50!.toFixed(2)}/${ev.ttfb.referenceDelta.p99!.toFixed(2)}ms  (${ev.ttfb.pairs} pairs, anomalies=${ev.ttfb.anomalies})`,
          `  chunk transit gate: max=${ev.gaps.transitMaxMs.toFixed(2)}ms (bound ±5, ${ev.gaps.gapSamples} samples over ${ev.gaps.runs} runs)`,
          `  gap-vs-nominal diag : absMax=${ev.gaps.nominalDeviations.absMax!.toFixed(2)}ms mean=${ev.gaps.nominalDeviations.mean.toFixed(2)}ms (not gated)`,
          `  gap-vs-baseline diag: absMax=${ev.gaps.pairedDeviations.absMax!.toFixed(2)}ms mean=${ev.gaps.pairedDeviations.mean.toFixed(2)}ms (not gated)`,
          `  holdback overhead   : mean=${ev.gaps.holdbackMeanMs.toFixed(2)}ms (T3 enforcement-budget evidence)`,
        ].join('\n'),
      )
    },
    960_000,
  )
})
