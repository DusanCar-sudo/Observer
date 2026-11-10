/**
 * The zero-mutation proof: the capture tap, judged by the V0 differential
 * fidelity rig across the ENTIRE corpus.
 *
 * Task-2's core acceptance line is "zero mutation of traffic" — this is where
 * that claim is measured rather than asserted: status, headers, body bytes with
 * offsets, upstream-request bytes, arrival counts/boundaries, chunk transit,
 * TTFB, and truncation offsets must all be diff-free with the tap in the path
 * (rewriteHost:false — the rig's mock upstream accepts any Host, so the tap runs
 * in its byte-perfect mode; the Host splice itself is verified surgically in
 * tap-roundtrip.test.ts).
 *
 * EXECUTION ENVIRONMENT: one batched plain-node CHILD PROCESS for the suite
 * (rig's isolated-conformance runner) — same rationale and same permanent
 * consequence as the rig conformance suite: the ±5ms chunk-transit bound is
 * unchanged, the measurement environment is, and under isolation a spike is a
 * REAL finding, never "environmental".
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runIsolatedConformance } from '@observer/rig'

const SUT_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'suts', 'tap.mjs')

const results = await runIsolatedConformance({ sutModule: SUT_MODULE, fixtures: 'all', timeoutMs: 900_000 })

describe('CaptureTap passes the differential fidelity rig on every fixture (child-process isolated)', () => {
  it('the corpus ran in full (>=30 fixtures)', () => {
    expect(results.length).toBeGreaterThanOrEqual(30)
  })

  for (const r of results) {
    it(`zero mutation through the tap: ${r.id}`, () => {
      console.log(`[tap-fidelity:${r.id}] ${r.diagnosticsLine}`)
      if (!r.passed) throw new Error(`\n${r.report}`)
      expect(r.diffCount).toBe(0)
    })
  }
})
