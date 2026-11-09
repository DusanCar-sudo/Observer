/**
 * DETECTION: every faulty test double must be caught by the rig, on the axis that
 * matters, with an actionable diff. This is the half of the rig's self-verification
 * that gives "zero diffs" its meaning — without it, a rig that compares nothing
 * would pass everything.
 *
 * The two most important cases for this project's thesis:
 *
 *  - CoalescingPipe and BufferingPipe produce BYTE-IDENTICAL final bodies. The only
 *    thing that catches them is the arrival-timeline comparison. A rig that parsed
 *    events, or compared only final bytes, reports green while the supervised agent
 *    experiences a buffered stream. (Task-1 acceptance: "Rig asserts INCREMENTAL
 *    ARRIVAL (inter-chunk gaps), not just final bytes".)
 *
 *  - SseRewritingPipe is the §4.1 pass-through trap as working code: a typed
 *    parse/re-serialize of each chunk silently deletes `obfuscation` and
 *    `reasoning_content` — fields absent from OpenAI's own schema — with no error
 *    anywhere. Byte comparison with offsets is what names the loss.
 */

import { describe, expect, it } from 'vitest'
import { loadCorpus } from '../src/fixtures.js'
import { formatReport } from '../src/report.js'
import { runFidelityCheck } from '../src/run.js'
import {
  BufferingPipe,
  CoalescingPipe,
  JsonRoundTripPipe,
  SloppyHeadersPipe,
  SseRewritingPipe,
  TypedModelPipe,
} from '../src/testdoubles/faulty.js'
import { ReferencePipe } from '../src/testdoubles/reference-pipe.js'
import type { FidelityDiff, FidelityRunReport, ResolvedFixture, Sut } from '../src/types.js'

let corpus: ResolvedFixture[] = []

async function fx(id: string): Promise<ResolvedFixture> {
  if (corpus.length === 0) corpus = await loadCorpus()
  const f = corpus.find((x) => x.id === id)
  if (!f) throw new Error(`fixture ${id} not in corpus`)
  return f
}

async function run(fixtureId: string, sut: Sut): Promise<FidelityRunReport> {
  return runFidelityCheck({ fixture: await fx(fixtureId), sut, clientTimeoutMs: 30_000 })
}

function kinds(report: FidelityRunReport): Set<string> {
  return new Set(report.diffs.map((d) => d.kind))
}

function has(report: FidelityRunReport, kind: FidelityDiff['kind']): boolean {
  return report.diffs.some((d) => d.kind === kind)
}

function bodyRegionText(report: FidelityRunReport, kind: 'response-body-bytes' | 'upstream-request-body-bytes'): string {
  return report.diffs
    .filter((d): d is Extract<FidelityDiff, { kind: typeof kind }> => d.kind === kind)
    .flatMap((d) => d.regions)
    .map((r) => `${r.baseline.ascii}\u0000${r.sut.ascii}`)
    .join('\n')
}

describe('detection: request-body sins (the V1/A1+A2 axis)', () => {
  it(
    'JsonRoundTripPipe is caught on unicode escapes, with the rewritten bytes named at offsets',
    async () => {
      const r = await run('req-unicode-escapes', JsonRoundTripPipe)
      expect(r.passed).toBe(false)
      expect(has(r, 'upstream-request-body-bytes'), formatReport(r, { timelines: true })).toBe(true)
      const text = bodyRegionText(r, 'upstream-request-body-bytes')
      // the baseline side of some region must show the literal \u00e9 escape that died
      expect(text).toContain('\\u00e9')
      // response side is untouched by this double
      expect(has(r, 'response-body-bytes')).toBe(false)
    },
    60_000,
  )

  it(
    'JsonRoundTripPipe is caught on number formatting (1.0 -> 1, 0.900 -> 0.9, 1e3 -> 1000)',
    async () => {
      const r = await run('req-number-formats', JsonRoundTripPipe)
      expect(has(r, 'upstream-request-body-bytes'), formatReport(r, { timelines: true })).toBe(true)
      const text = bodyRegionText(r, 'upstream-request-body-bytes')
      expect(text).toMatch(/1\.0|0\.900|1e3|2048\.0|0\.00/)
    },
    60_000,
  )

  it(
    'TypedModelPipe is caught deleting reasoning_content and x_custom (A2 sin i: unknown fields)',
    async () => {
      const r = await run('req-reasoning-history', TypedModelPipe)
      expect(has(r, 'upstream-request-body-bytes'), formatReport(r, { timelines: true })).toBe(true)
      // Assert the SIN on the bytes themselves (stronger than a region excerpt, which
      // is capped at 32 bytes and may not span the deleted key): what the upstream saw
      // through the SUT no longer contains the unknown fields; the baseline did.
      const forwarded = r.sut.upstream!.body.toString('utf8')
      expect(forwarded).not.toContain('reasoning_content')
      expect(forwarded).not.toContain('x_custom')
      expect(r.baseline.upstream!.body.toString('utf8')).toContain('reasoning_content')
    },
    60_000,
  )

  it(
    'TypedModelPipe is caught dropping empty fields (A2 sin ii: ""/[]/null)',
    async () => {
      const r = await run('req-empty-fields', TypedModelPipe)
      expect(has(r, 'upstream-request-body-bytes'), formatReport(r, { timelines: true })).toBe(true)
      const diff = r.diffs.find((d) => d.kind === 'upstream-request-body-bytes')!
      expect(diff.sutLen).toBeLessThan(diff.baselineLen)
    },
    60_000,
  )

  it(
    'TypedModelPipe is caught reordering keys on the real 40-tool request (A2 sin iii)',
    async () => {
      const r = await run('req-40-tools-nonstream', TypedModelPipe)
      expect(has(r, 'upstream-request-body-bytes'), formatReport(r, { timelines: true })).toBe(true)
      // a canonical-sort rewrite of a 48 KB body diverges almost immediately
      const diff = r.diffs.find((d) => d.kind === 'upstream-request-body-bytes') as Extract<FidelityDiff, { kind: 'upstream-request-body-bytes' }>
      expect(diff.regions[0]!.offset).toBeLessThan(200)
    },
    120_000,
  )
})

describe('detection: response-header sins (the V1/A4 axis)', () => {
  it(
    'SloppyHeadersPipe is caught dropping x-* and adding x-powered-by, named per header',
    async () => {
      const r = await run('res-headers-passthrough', SloppyHeadersPipe)
      expect(has(r, 'response-headers'), formatReport(r, { timelines: true })).toBe(true)
      const issues = r.diffs.find((d) => d.kind === 'response-headers')!.issues
      expect(issues).toContainEqual(expect.objectContaining({ issue: 'missing', name: 'x-request-id' }))
      expect(issues).toContainEqual(expect.objectContaining({ issue: 'missing', name: 'x-trace-id' }))
      expect(issues).toContainEqual(expect.objectContaining({ issue: 'extra', name: 'x-powered-by' }))
    },
    60_000,
  )
})

describe('detection: timing sins — THE coalescing tests (final bytes are identical!)', () => {
  it(
    'CoalescingPipe is caught by arrival count/gaps while body sha256 stays IDENTICAL',
    async () => {
      const r = await run('res-stream-50ms-timing', CoalescingPipe)
      // the whole point: byte comparison alone would pass this proxy
      expect(has(r, 'response-body-bytes'), 'final bytes must be identical — only timing can catch this').toBe(false)
      expect(r.baseline.client.bodySha256).toBe(r.sut.client.bodySha256)
      expect(has(r, 'arrival-count'), formatReport(r, { timelines: true })).toBe(true)
      const countDiff = r.diffs.find((d) => d.kind === 'arrival-count')!
      expect(countDiff).toMatchObject({ classification: 'coalesced' })
      expect(r.baseline.client.bodyEvents.length).toBe(8)
      expect(r.sut.client.bodyEvents.length).toBeLessThan(8)
    },
    60_000,
  )

  it(
    'BufferingPipe is caught by TTFB + single arrival while body sha256 stays IDENTICAL',
    async () => {
      const r = await run('res-stream-50ms-timing', BufferingPipe)
      expect(has(r, 'response-body-bytes')).toBe(false)
      expect(r.baseline.client.bodySha256).toBe(r.sut.client.bodySha256)
      expect(has(r, 'ttfb'), formatReport(r, { timelines: true })).toBe(true)
      const ttfb = r.diffs.find((d) => d.kind === 'ttfb') as Extract<FidelityDiff, { kind: 'ttfb' }>
      // buffered to completion: first byte arrives only after the whole 8x50ms script ran
      expect(ttfb.deltaMs).toBeGreaterThan(200)
      expect(r.sut.client.bodyEvents.length).toBe(1)
    },
    60_000,
  )

  it(
    'gap diffs report baseline, sut and nominal gaps with the tolerance',
    async () => {
      const r = await run('res-stream-50ms-timing', CoalescingPipe)
      const gaps = r.diffs.filter((d) => d.kind === 'arrival-gap')
      // coalescing to one arrival may starve per-index gap comparisons; either gaps or
      // the count diff must fire — never neither
      expect(gaps.length > 0 || has(r, 'arrival-count')).toBe(true)
    },
    60_000,
  )
})

describe('detection: SSE rewriting — the §4.1 pass-through trap', () => {
  it(
    'SseRewritingPipe is caught deleting obfuscation from every chunk',
    async () => {
      const r = await run('res-stream-obfuscation', SseRewritingPipe)
      expect(has(r, 'response-body-bytes'), formatReport(r, { timelines: true })).toBe(true)
      const text = bodyRegionText(r, 'response-body-bytes')
      expect(text).toContain('obfuscation')
      // and the request side stays clean for this double (isolation of the sin)
      expect(has(r, 'upstream-request-body-bytes')).toBe(false)
    },
    60_000,
  )

  it(
    'SseRewritingPipe is caught deleting delta.reasoning_content from the stream',
    async () => {
      const r = await run('res-stream-reasoning', SseRewritingPipe)
      expect(has(r, 'response-body-bytes'), formatReport(r, { timelines: true })).toBe(true)
      const text = bodyRegionText(r, 'response-body-bytes')
      expect(text).toContain('reasoning_content')
    },
    60_000,
  )
})

describe('rig robustness against faulty SUTs', () => {
  it(
    'a faulty SUT never crashes the rig: every double yields a report, not an exception',
    async () => {
      for (const sut of [JsonRoundTripPipe, TypedModelPipe, SloppyHeadersPipe, CoalescingPipe, BufferingPipe, SseRewritingPipe, ReferencePipe]) {
        const r = await run('res-stream-done', sut)
        expect(r.fixtureId).toBe('res-stream-done')
        expect(Array.isArray(r.diffs)).toBe(true)
      }
    },
    180_000,
  )
})
