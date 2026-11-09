/**
 * The zero-mutation proof: the capture tap, judged by the V0 differential
 * fidelity rig across the ENTIRE corpus.
 *
 * Task-2's core acceptance line is "zero mutation of traffic" — this is where
 * that claim is measured rather than asserted: status, headers, body bytes with
 * offsets, upstream-request bytes, arrival counts/boundaries/gaps, TTFB, and
 * truncation offsets must all be diff-free with the tap in the path
 * (rewriteHost:false — the rig's mock upstream accepts any Host, so the tap runs
 * in its byte-perfect mode; the Host splice itself is verified surgically in
 * tap-roundtrip.test.ts).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { formatReport, loadCorpus, runFidelityCheck } from '@observer/rig'
import type { ResolvedFixture, Sut } from '@observer/rig'
import { startTap } from '../src/tap.js'

const temps: string[] = []
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'observer-tap-fidelity-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

/** Wrap the tap as a rig SUT. */
function tapSut(outDir: string): Sut {
  return {
    name: 'CaptureTap',
    async start(ctx) {
      const tap = await startTap({
        upstreamOrigin: ctx.upstreamOrigin,
        outDir,
        listenPort: 0,
        rewriteHost: false,
      })
      return {
        port: tap.port,
        stop: async () => {
          await tap.stop()
        },
      }
    },
  }
}

let corpus: ResolvedFixture[] = []

describe('CaptureTap passes the differential fidelity rig on every fixture', () => {
  it('loads the corpus', async () => {
    corpus = await loadCorpus()
    expect(corpus.length).toBeGreaterThanOrEqual(20)
  }, 60_000)

  const sut = tapSut(tempDir())

  const ids = [
    'req-40-tools-nonstream',
    'req-reasoning-history',
    'req-empty-fields',
    'req-number-formats',
    'req-unicode-escapes',
    'req-big-5mb',
    'req-stream-options',
    'req-long-system',
    'req-tool-results',
    'req-identity-fields',
    'res-nonstream-json',
    'res-stream-done',
    'res-stream-reasoning',
    'res-stream-parallel-tools',
    'res-stream-obfuscation',
    'res-stream-split-writes',
    'res-stream-50ms-timing',
    'res-stream-empty-reasoning',
    'res-stream-interrupted-no-done',
    'res-abort-mid-chunk',
    'res-429-json',
    'res-400-json-invalid',
    'res-502-nonjson',
    'res-gzip-nonstream',
    'res-headers-passthrough',
    'res-stream-unicode-split',
    'res-stream-retry-partial',
    'res-stream-retry-complete',
  ]

  for (const id of ids) {
    it(
      `zero mutation through the tap: ${id}`,
      async () => {
        if (corpus.length === 0) corpus = await loadCorpus()
        const fixture = corpus.find((f) => f.id === id)
        expect(fixture, `fixture ${id} missing`).toBeDefined()
        const report = await runFidelityCheck({ fixture: fixture!, sut })
        if (report.diffs.length > 0) {
          throw new Error(`\n${formatReport(report, { timelines: true })}`)
        }
        expect(report.passed).toBe(true)
      },
      120_000,
    )
  }
})
