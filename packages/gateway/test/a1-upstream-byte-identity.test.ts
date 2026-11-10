/**
 * A1 — UPSTREAM BODY BYTE-IDENTITY, verified on EVERY fixture by the rig.
 *
 * "Bytes sent upstream are sha256-identical to bytes received from the client.
 * NO JSON.parse → JSON.stringify anywhere on this path."
 *
 * This file runs the full differential conformance (which includes the A1 axis
 * plus status/headers/response-bytes/arrival timelines/TTFB/truncation) and adds
 * the named A1 assertion on top: for every fixture, the sha256 the upstream saw
 * equals the sha256 of the bytes the client sent. The fixture list is loaded
 * dynamically, so a fixture added to the corpus is AUTOMATICALLY covered here —
 * the criterion says "every fixture" and the test cannot drift from that.
 */

import { describe, expect, it } from 'vitest'
import { formatReport, runFidelityCheck, sha256 } from '@observer/rig'
import { corpus, gatewaySut } from './helpers.js'

const all = await corpus()

describe('A1 — upstream body byte-identity (full-corpus rig conformance)', () => {
  it('corpus is loaded and non-trivial', () => {
    expect(all.length).toBeGreaterThanOrEqual(20)
  })

  for (const fx of all) {
    it(
      `A1 + zero-diff conformance: ${fx.id}`,
      async () => {
        const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
        if (report.diffs.length > 0) {
          throw new Error(`\n${formatReport(report, { timelines: true })}`)
        }
        // Named A1 assertion: what the upstream saw IS what the client sent.
        expect(report.sut.upstream, 'upstream saw no request').toBeDefined()
        expect(report.sut.upstream!.bodySha256).toBe(sha256(fx.request.body))
        expect(report.sut.upstream!.bodyComplete).toBe(true)
      },
      180_000,
    )
  }
})
