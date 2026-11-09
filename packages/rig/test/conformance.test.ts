/**
 * CONFORMANCE: the byte-faithful ReferencePipe must produce ZERO diffs on every
 * fixture in the corpus.
 *
 * This is one half of the rig's self-verification (detect.test.ts is the other):
 * a rig that flags a faithful proxy produces false alarms that train everyone to
 * ignore it; a rig that passes everything proves nothing. Both halves together are
 * what make "the rig is green" a meaningful sentence — the standard V1's A1/A3 and
 * V4's socket-byte identity will be judged by.
 *
 * Runs sequentially (fileParallelism: false in vitest.config.ts) because timing
 * fidelity is under test: parallel files would manufacture scheduler jitter.
 */

import { describe, expect, it } from 'vitest'
import { loadCorpus } from '../src/fixtures.js'
import { formatReport } from '../src/report.js'
import { runFidelityCheck } from '../src/run.js'
import { ReferencePipe } from '../src/testdoubles/reference-pipe.js'
import type { ResolvedFixture } from '../src/types.js'

let corpus: ResolvedFixture[] = []

describe('ReferencePipe conformance — zero diffs on every fixture', () => {
  it('loads the corpus', async () => {
    corpus = await loadCorpus()
    expect(corpus.length).toBeGreaterThanOrEqual(20)
  }, 120_000)

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
    'res-br-nonstream',
    'res-headers-passthrough',
    'res-stream-unicode-split',
    'res-stream-retry-partial',
    'res-stream-retry-complete',
  ]

  for (const id of ids) {
    it(
      `passes byte/timeline fidelity: ${id}`,
      async () => {
        if (corpus.length === 0) corpus = await loadCorpus()
        const fx = corpus.find((f) => f.id === id)
        expect(fx, `fixture ${id} missing from corpus`).toBeDefined()
        const report = await runFidelityCheck({ fixture: fx!, sut: ReferencePipe })
        // On failure, throw the full formatted report — offsets, hex, timelines.
        // (vitest does not invoke a function passed as expect()'s message argument,
        // so the report is rendered into the thrown error instead.)
        if (report.diffs.length > 0) {
          throw new Error(`\n${formatReport(report, { timelines: true })}`)
        }
        expect(report.passed).toBe(true)
      },
      120_000,
    )
  }
})
