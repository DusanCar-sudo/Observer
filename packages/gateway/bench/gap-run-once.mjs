#!/usr/bin/env node
/**
 * One gap-criterion run in a FRESH PROCESS (V4b harness building block).
 *
 * WHY PER-ITERATION PROCESSES: the 25-run gap loop previously ran inside the
 * long-lived harness process and showed ~1-in-200 chunk-transit spikes of
 * 6-11 ms while the SAME session's 400-pair TTFB section stayed at p99 ≈ 1 ms
 * and the baseline arm stayed ≤ 0.2 ms. The spikes tracked harness-process
 * state (25 accumulated fidelity reports, server/socket create-destroy churn,
 * heap growth), not gateway behaviour — forwarding telemetry inside a spiked
 * run was pristine (mean 1-1.5 ms). A fresh process per iteration gives each
 * measurement a flat heap and an empty fd table, and matches production
 * topology (the gateway is its own process there).
 *
 * Prints ONE JSON line: per-run evidence (diffs, transit stats, gap deviations).
 * Exit code 0 always (violations are data for the aggregator, not crashes).
 *
 * Usage: node bench/gap-run-once.mjs <fixtureId>
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  formatReport,
  loadCorpus,
  runFidelityCheck,
} from '../../rig/dist/index.js'
import { startGateway } from '../dist/index.js'

const fixtureId = process.argv[2]
if (!fixtureId) {
  console.log(JSON.stringify({ error: 'usage: gap-run-once.mjs <fixtureId>' }))
  process.exit(0)
}

const out = { fixtureId, ok: false, diffs: [], transit: null, nominalDevs: [], pairedDevs: [], holdback: [], report: null }
try {
  const corpus = await loadCorpus()
  const fixture = corpus.find((f) => f.id === fixtureId)
  if (!fixture) throw new Error(`fixture ${fixtureId} not found`)

  const sut = {
    name: 'GatewayV1-forwarding-path',
    async start(ctx) {
      // capture:false — the gap criterion gates the FORWARDING path (§9.8
      // jurisdiction split); capture cost is Gate B's and V2's number.
      const gw = await startGateway({
        upstreamOrigin: ctx.upstreamOrigin,
        rewriteHost: false,
        capture: false,
        listenPort: 0,
      })
      return { port: gw.port, stop: () => gw.stop() }
    },
  }

  const report = await runFidelityCheck({ fixture, sut, timing: { ttfbBudgetMs: 250 } })
  out.ok = report.diffs.length === 0
  out.diffs = report.diffs.map((d) => ({ kind: d.kind, ...(d.kind === 'chunk-transit' ? { index: d.index, emitToArrivalMs: d.emitToArrivalMs } : {}) }))
  if (!out.ok) out.report = formatReport(report)
  out.transit = report.diagnostics.chunkTransit

  const expected = fixture.response.expectedArrivals.length
  const nominal = fixture.response.expectedArrivals.map((a) => a.nominalGapMs)
  const b = report.baseline.client.bodyEvents
  const s = report.sut.client.bodyEvents
  if (s.length === expected && b.length === expected) {
    for (let k = 1; k < s.length; k++) {
      const gapS = s[k].tMs - s[k - 1].tMs
      const gapB = b[k].tMs - b[k - 1].tMs
      out.nominalDevs.push(gapS - nominal[k])
      out.pairedDevs.push(gapS - gapB)
      out.holdback.push(s[k].tMs - b[k].tMs)
    }
  } else {
    out.diffs.push({ kind: 'arrival-count-mismatch', expected, baseline: b.length, sut: s.length })
    out.ok = false
  }
} catch (err) {
  out.error = err instanceof Error ? err.message : String(err)
}
console.log(JSON.stringify(out))
process.exit(0)
