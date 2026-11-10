#!/usr/bin/env node
/**
 * V4b timing harness — runs in a CLEAN NODE PROCESS, on purpose.
 *
 * WHY NOT INSIDE VITEST: timing-fidelity measurement needs a trustworthy
 * scheduler. Inside a test-framework worker, the mock upstream's deadline
 * timers, the gateway, and the client's timestamps share one event loop with
 * framework housekeeping; over 200ms streaming exchanges a single stall lands
 * inside a measured window. Measured in-worker: ttfb delta p99 = 229 ms with
 * min = -34 ms (noise in BOTH directions — environment, not gateway). Same
 * harness in a clean process: ~1ms deltas. Measuring latency inside a test
 * runner measures the test runner.
 *
 * WHY NOT A SUBPROCESS GATEWAY (measured, do not "improve" this back):
 * isolating the gateway into a child process made numbers WORSE on this machine
 * (ttfb p99 9-17ms, holdback 8-11ms vs in-process 3.6ms/0.6ms) — cross-process
 * scheduler hops cost more than shared-loop interference here. In-process with
 * a clean node runtime is the best single-machine fidelity available.
 *
 * ASSERTION SHAPE (lead-approved option (a), spec §9.5/§9.7):
 *  - TTFB: triple-arm interleaved — per iteration ONE direct baseline, then the
 *    gateway, then the ReferencePipe, both deltas against the SAME direct run.
 *    Gates: gateway delta p50 < 5 ms ABSOLUTE (systematic cost); gateway p99 <=
 *    ReferencePipe p99 (reference-relative tail — an absolute tail bound on a
 *    shared machine fails even the known-faithful reference, i.e. measures the
 *    machine's tenants, not the gateway). The reference arm is measured in THIS
 *    session, never cached — a stored baseline would silently turn the
 *    comparison absolute again.
 *  - Gaps: the §9.7 gate is per-chunk `arrival - emit` <= 5 ms (single-arm,
 *    asserted by the rig itself as the chunk-transit axis, hard in every run);
 *    gap-vs-nominal and gap-vs-baseline are EVIDENCE, printed, never gated —
 *    under load the mock's own arm jitters and a faithful forwarder inherits
 *    that jitter honestly.
 *
 * Prints ONE JSON evidence object on stdout; human-readable evidence on stderr.
 * Usage: node bench/v4b-timing.mjs [--ttfb-pairs N] [--ttfb-warmup N] [--gap-runs N]
 * Requires: pnpm --filter @observer/rig build && pnpm --filter @observer/gateway build
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  loadCorpus,
  ReferencePipe,
  runClient,
  startMockUpstream,
} from '../../rig/dist/index.js'
import { startGateway } from '../dist/index.js'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}
const TTFB_PAIRS = arg('ttfb-pairs', 400)
const TTFB_WARMUP = arg('ttfb-warmup', 25)
const GAP_RUNS = arg('gap-runs', 25)
const TOL_MS = 5 // the criterion's own bound; not tunable

const log = (...a) => console.error(...a)
const dirs = []
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'v4b-bench-'))
  dirs.push(d)
  return d
}

const corpus = await loadCorpus()
const byId = (id) => {
  const f = corpus.find((x) => x.id === id)
  if (!f) throw new Error(`fixture ${id} missing`)
  return f
}
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : NaN
}
const statsOf = (xs) => ({
  count: xs.length,
  min: xs.length ? Math.min(...xs) : 0,
  p50: pct(xs, 0.5),
  p90: pct(xs, 0.9),
  p99: pct(xs, 0.99),
  max: xs.length ? Math.max(...xs) : 0,
  mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
})

// ---------------------------------------------------------------------------
// 1. TTFB — four arms, same session, interleaved, rotating order (spec §9.5/§9.8)
//
// Per iteration: ONE direct baseline, then gateway(capture OFF), gateway(capture
// ON, the shipping config), and ReferencePipe — arm order rotates per iteration
// so cache-warmth/GC-debt ordering bias cannot favor anyone. All three deltas are
// computed against the SAME direct run taken moments earlier.
//
// GATES (lead-approved option (i) + capture-cost delta gate):
//   A (hard): p99(gateway-capture-off − direct) ≤ p99(ReferencePipe − direct).
//     The forwarding-fidelity gate. ReferencePipe is a FIDELITY double with no
//     recorder, so comparing capture-ON against it would conflate forwarding
//     overhead with recording cost — the ~0.9ms separation measured in the
//     decomposition run. Capture-off vs reference isolates forwarding.
//   B (hard): p50(gateway-capture-on − direct) − p50(gateway-capture-off − direct)
//     ≤ 1.5 ms. The capture-cost gate. Derivation of 1.5 (NOT an invented
//     margin): measured capture-on-minus-off p50 delta ≈ 0.9 ms (three-arm
//     decomposition, 2026-11-10: on 1.47 / off 0.57), rounded up for machine
//     variance. p50, not p99, because the cost is structural (mkdirSync + first
//     writes on the exchange-start path) and the median tracks structural cost;
//     a p99 gate here would reintroduce the noise sensitivity §9.7 removed.
//     END STATE (recorded in task-4): V2's write-behind spool must bring this
//     delta to ≤ 0.3 ms, at which point Gate A is re-run with capture ON and
//     Gate B is RETIRED. A temporary gate without a removal condition is a
//     permanent gate with an apology.
//   Absolute: p50(gateway-capture-on − direct) < 5 ms — the criterion's own
//     number against the SHIPPING configuration. p50 stays absolute by design
//     (lead: the reference-relative logic must not creep onto the median).
//   §9.2: every arm's body sha is checked every iteration; any divergence is an
//     anomaly and anomalies invalidate the whole benchmark.
// ---------------------------------------------------------------------------
let ttfb
{
  const fx = byId('res-stream-ttfb-probe')
  const up = await startMockUpstream(fx.response.script, fx.response.payloads)
  const gwOn = await startGateway({
    upstreamOrigin: up.origin,
    rewriteHost: false,
    captureOutDir: tempDir(),
    listenPort: 0,
  })
  const gwOff = await startGateway({
    upstreamOrigin: up.origin,
    rewriteHost: false,
    capture: false,
    listenPort: 0,
  })
  const ref = await ReferencePipe.start({ upstreamOrigin: up.origin, upstreamPort: up.port })

  const expectedSha = createHash('sha256').update(Buffer.concat(fx.response.payloads)).digest('hex')
  const deltas = { gwOff: [], gwOn: [], ref: [] }
  const raw = { direct: [], gwOff: [], gwOn: [], ref: [] }
  const anomalies = []

  const run = (port) => runClient({ port, headBytes: fx.request.headBytes, body: fx.request.body, timeoutMs: 15_000 })
  const arms = [
    { name: 'gwOff', port: () => gwOff.port },
    { name: 'gwOn', port: () => gwOn.port },
    { name: 'ref', port: () => ref.port },
  ]

  for (let i = 0; i < TTFB_WARMUP + TTFB_PAIRS; i++) {
    const d = await run(up.port)
    // rotate arm order per iteration
    const order = [...arms.slice(i % 3), ...arms.slice(0, i % 3)]
    const got = {}
    for (const arm of order) got[arm.name] = await run(arm.port())
    for (const [label, res] of [['direct', d], ...Object.entries(got)]) {
      if (res.bodySha256 !== expectedSha) anomalies.push(`iteration ${i}: ${label} body sha diverged`)
      if (!res.head || res.timedOut) anomalies.push(`iteration ${i}: ${label} broken exchange`)
    }
    if (d.ttfbMs === undefined || got.gwOff.ttfbMs === undefined || got.gwOn.ttfbMs === undefined || got.ref.ttfbMs === undefined) {
      anomalies.push(`iteration ${i}: missing ttfb`)
      continue
    }
    if (i < TTFB_WARMUP) continue
    raw.direct.push(d.ttfbMs)
    for (const name of ['gwOff', 'gwOn', 'ref']) {
      raw[name].push(got[name].ttfbMs)
      deltas[name].push(got[name].ttfbMs - d.ttfbMs)
    }
  }

  await ref.stop()
  await gwOn.stop()
  await gwOff.stop()
  await up.stop()

  const p50GwOn = pct(deltas.gwOn, 0.5)
  const p50GwOff = pct(deltas.gwOff, 0.5)
  const p99GwOff = pct(deltas.gwOff, 0.99)
  const p99Ref = pct(deltas.ref, 0.99)
  ttfb = {
    pairs: TTFB_PAIRS,
    warmup: TTFB_WARMUP,
    anomalies: anomalies.length,
    anomalySample: anomalies.slice(0, 3),
    gatewayOffDelta: statsOf(deltas.gwOff),
    gatewayOnDelta: statsOf(deltas.gwOn),
    referenceDelta: statsOf(deltas.ref),
    directTtfb: statsOf(raw.direct),
    gatewayOnStats: gwOn.stats(),
    gates: {
      A_forwardingFidelity: { pass: p99GwOff <= p99Ref, gwOffP99: p99GwOff, referenceP99: p99Ref },
      B_captureCostP50: { pass: p50GwOn - p50GwOff <= 1.5, deltaMs: p50GwOn - p50GwOff, budgetMs: 1.5 },
      absoluteP50Shipping: { pass: p50GwOn < TOL_MS, gwOnP50: p50GwOn, budgetMs: TOL_MS },
    },
  }
  log('[V4b TTFB evidence] ' + JSON.stringify(ttfb, null, 2))
}

// ---------------------------------------------------------------------------
// 2. Inter-chunk timing at the spec cadence: the §9.7 chunk-transit gate runs
//    inside runFidelityCheck (hard, ±5ms, every chunk, every run). Nominal and
//    paired gap deviations are collected here as EVIDENCE ONLY.
//
//    Each run executes in a FRESH CHILD PROCESS (bench/gap-run-once.mjs): the
//    long-lived-harness version showed ~1-in-200 transit spikes (6-11ms) that
//    tracked harness process state (heap growth across 25 accumulated reports,
//    server churn), not gateway behaviour — same-session TTFB arms stayed at
//    p99 ≈ 1ms while the gap loop spiked. Fresh processes = flat heap, empty
//    fd table, production-like isolation. See gap-run-once.mjs header.
// ---------------------------------------------------------------------------
const gapEvidence = {
  runs: GAP_RUNS,
  toleranceMs: TOL_MS,
  gapSamples: 0,
  transitMaxMs: 0,
  nominalDeviations: { min: 0, max: 0, absMax: 0, mean: 0 },
  pairedDeviations: { min: 0, max: 0, absMax: 0, mean: 0 },
  holdbackMeanMs: 0,
  violations: [],
}
{
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const nomDev = []
  const pairDev = []
  const holds = []

  for (let run = 0; run < GAP_RUNS; run++) {
    const child = spawnSync(process.execPath, [path.join(here, 'gap-run-once.mjs'), 'res-stream-50ms-timing'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (child.status !== 0 && child.status !== null) {
      gapEvidence.violations.push(`run ${run}: child exited ${child.status}: ${(child.stderr ?? '').slice(0, 500)}`)
      continue
    }
    let res
    try {
      res = JSON.parse(child.stdout.trim().split('\n').pop())
    } catch (e) {
      gapEvidence.violations.push(`run ${run}: unparseable child output: ${String(e)} — ${(child.stdout ?? '').slice(0, 300)}`)
      continue
    }
    if (res.error) {
      gapEvidence.violations.push(`run ${run}: child error: ${res.error}`)
      continue
    }
    if (!res.ok) {
      gapEvidence.violations.push(`run ${run}: rig diffs:\n${res.report ?? JSON.stringify(res.diffs)}`)
      continue
    }
    if (res.transit) gapEvidence.transitMaxMs = Math.max(gapEvidence.transitMaxMs, res.transit.maxMs)
    nomDev.push(...res.nominalDevs)
    pairDev.push(...res.pairedDevs)
    holds.push(...res.holdback)
  }
  const devStats = (xs) => ({
    n: xs.length,
    min: xs.length ? Math.min(...xs) : 0,
    max: xs.length ? Math.max(...xs) : 0,
    absMax: xs.length ? Math.max(...xs.map(Math.abs)) : 0,
    mean: xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0,
  })
  gapEvidence.gapSamples = nomDev.length
  gapEvidence.nominalDeviations = devStats(nomDev)
  gapEvidence.pairedDeviations = devStats(pairDev)
  gapEvidence.holdbackMeanMs = holds.length ? holds.reduce((a, c) => a + c, 0) / holds.length : 0
  log('[V4b gap evidence] ' + JSON.stringify(gapEvidence, null, 2))
}

for (const d of dirs) rmSync(d, { recursive: true, force: true })
console.log(JSON.stringify({ ttfb, gaps: gapEvidence }, null, 2))
