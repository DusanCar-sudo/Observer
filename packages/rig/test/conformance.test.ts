/**
 * CONFORMANCE: the byte-faithful ReferencePipe must produce ZERO diffs on every
 * fixture in the corpus.
 *
 * This is one half of the rig's self-verification (detect.test.ts is the other):
 * a rig that flags a faithful proxy produces false alarms that train everyone to
 * ignore it; a rig that passes everything proves nothing. Both halves together
 * are what make "the rig is green" a meaningful sentence.
 *
 * EXECUTION ENVIRONMENT (lead decision 2026-11-10): these runs execute in ONE
 * plain-node CHILD PROCESS for the whole suite (bin/isolated-conformance.mjs),
 * not inside the vitest worker. The chunk-transit gate stayed hard at ±5ms per
 * chunk; what changed is where the measurement is taken. In-worker runs showed
 * ~0.4%/run single-chunk spikes (6-11ms) from worker starvation while the same
 * code in fresh processes measured 0 spikes over ~1050 samples.
 * CONSEQUENCE, PERMANENT: under child-process isolation a transit spike is a
 * REAL FINDING — never reclassify it as environmental. Isolation exists precisely
 * to remove the environmental explanation.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runIsolatedConformance } from '../src/isolated.js'

const SUT_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'suts', 'reference.mjs')

// One batched child process for the whole suite; results marshalled back as NDJSON.
const results = await runIsolatedConformance({ sutModule: SUT_MODULE, fixtures: 'all', timeoutMs: 900_000 })
const byId = new Map(results.map((r) => [r.id, r]))

describe('ReferencePipe conformance — zero diffs on every fixture (child-process isolated)', () => {
  it('the corpus ran in full (>=30 fixtures, no runner losses)', () => {
    expect(results.length).toBeGreaterThanOrEqual(30)
    expect(results.every((r) => r.diffCount !== -1), 'runner exception in at least one fixture').toBe(true)
  })

  for (const r of results) {
    it(`passes byte/timeline fidelity: ${r.id}`, () => {
      // §9.7: diagnostics print EVERY run — a diagnostic that stops being printed
      // is a measurement that quietly stopped existing. The spikes counter
      // distinguishes a clean run from a run that survived near the bound.
      console.log(`[conformance:${r.id}] ${r.diagnosticsLine}`)
      if (!r.passed) throw new Error(`\n${r.report}`)
      expect(r.diffCount).toBe(0)
    })
  }

  it('no fixture leaked transit spikes without failing (spikes>0 must imply !passed)', () => {
    for (const r of results) {
      const spikes = r.diagnostics?.chunkTransit.spikes ?? 0
      if (spikes > 0) {
        // Under isolation this is a REAL finding (see file header) — surface loudly.
        expect(r.passed, `${r.id}: ${spikes} transit spike(s) under child-process isolation are a real finding, not environment`).toBe(false)
      }
    }
  })
  void byId
})
