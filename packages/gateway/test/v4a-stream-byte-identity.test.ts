/**
 * V4a — SOCKET-BYTE IDENTITY INCLUDING CHUNK BOUNDARIES.
 *
 * The acceptance criterion, verbatim: "bytes delivered to the client are
 * identical to bytes received from upstream, INCLUDING CHUNK BOUNDARIES.
 * Asserted on the RAW BYTE STREAM, not on parsed events — a rig that parses
 * before comparing cannot detect coalescing."
 *
 * Per lead's carry-forward from the A5 ordering bug: the ORDERING tests here
 * were written to drive the implementation — events must be emitted at the
 * decision, before anything the client can observe (socket close), so counters
 * are consistent with observable outcomes. If proxy-core's emit ordering ever
 * regresses, the truncation/abort ordering tests fail even when the bytes are
 * still perfect.
 *
 * Structure of proof in this file:
 *  1. per-shape named tests (basic SSE, scale, splits, unicode-split,
 *     obfuscation, reasoning, parallel tools, truncation shapes);
 *  2. a criterion-level sweep: EVERY chunked (streaming) fixture in the corpus
 *     gets the per-arrival boundary-identity assertion — the fixture list is
 *     dynamic, so a new streaming fixture is covered automatically;
 *  3. recording↔delivery agreement: what the gateway RECORDED (response.wire)
 *     decodes to exactly what the client RECEIVED — the capture cannot claim
 *     bytes the client never saw, or vice versa.
 *
 * All comparisons are on decoded-body arrival sequences (byte counts + order)
 * and raw byte equality. Nothing in this file parses an SSE event or a JSON
 * body to decide pass/fail; substring assertions check byte presence only.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  corpus,
  exchangeViaGateway,
  fixture,
  gatewaySut,
  tempDir,
  waitMeta,
} from './helpers.js'
import { formatReport, ResponseDecoder, runClient, runFidelityCheck, sha256, startMockUpstream } from '@observer/rig'
import type { FidelityRunReport, ResolvedFixture } from '@observer/rig'
import { startGateway } from '../src/index.js'

/** Run one fixture through the gateway with full differential + zero-diff gate. */
async function runShape(id: string): Promise<{ fx: ResolvedFixture; report: FidelityRunReport }> {
  const fx = await fixture(id)
  const sut = gatewaySut()
  const report = await runFidelityCheck({ fixture: fx, sut })
  if (report.diffs.length > 0) throw new Error(`\n${formatReport(report, { timelines: true })}`)
  return { fx, report }
}

/** The V4a core assertion: identical arrival structure on the raw byte stream. */
function expectBoundaryIdentity(report: FidelityRunReport, fx: ResolvedFixture): void {
  const b = report.baseline.client.bodyEvents
  const s = report.sut.client.bodyEvents
  expect(s.length, 'arrival count (coalescing/splitting detector)').toBe(b.length)
  expect(s.length).toBe(fx.response.expectedArrivals.length)
  expect(s.map((e) => e.bytes), 'per-arrival byte lengths = chunk boundaries').toEqual(b.map((e) => e.bytes))
  expect(s.map((e) => e.cumBytes), 'cumulative boundary offsets').toEqual(b.map((e) => e.cumBytes))
  expect(report.sut.client.bodySha256).toBe(report.baseline.client.bodySha256)
}

describe('V4a — per-shape socket-byte identity', () => {
  it('basic SSE stream: arrivals, boundaries, body, and exactly one [DONE]', async () => {
    const { fx, report } = await runShape('res-stream-done')
    expectBoundaryIdentity(report, fx)
    const delivered = report.sut.client.body.toString('utf8')
    expect(delivered).toBe(Buffer.concat(fx.response.payloads).toString('utf8'))
    expect(delivered.split('data: [DONE]').length - 1).toBe(1) // exactly once
    expect(report.sut.client.framingComplete).toBe(true)
  }, 120_000)

  it('boundary preservation at scale: 151 fast arrivals, one per scripted write', async () => {
    const { fx, report } = await runShape('res-stream-many-events')
    expectBoundaryIdentity(report, fx)
    expect(report.sut.client.bodyEvents.length).toBe(151)
    // every arrival is a whole SSE event here (no splits scripted): each carries
    // its own 'data: ' prefix and \n\n terminator — byte presence, not parsing
    const delivered = report.sut.client.body.toString('utf8')
    expect(delivered.split('\n\n').length - 1).toBe(151)
  }, 120_000)

  it('mid-frame TCP split: both halves arrive as separate arrivals with exact byte lengths', async () => {
    const { fx, report } = await runShape('res-stream-split-writes')
    expectBoundaryIdentity(report, fx)
    // write #1 is scripted with splitAfterBytes: the first TCP write carries exactly
    // that many PAYLOAD bytes of the frame; find it in the fixture and in the arrivals
    const splitWrite = fx.response.script.writes.findIndex((w) => w.splitAfterBytes !== undefined)
    expect(splitWrite).toBeGreaterThanOrEqual(0)
    const splitAt = fx.response.script.writes[splitWrite]!.splitAfterBytes!
    // arrivals [0..splitWrite-1] mirror writes[0..splitWrite-1]; the split write
    // becomes arrival[splitWrite] (first TCP half) + arrival[splitWrite+1] (continuation)
    expect(report.sut.client.bodyEvents[splitWrite]!.bytes).toBe(splitAt)
    expect(report.sut.client.bodyEvents[splitWrite + 1]!.bytes).toBe(
      fx.response.payloads[splitWrite]!.length - splitAt,
    )
  }, 120_000)

  it('split inside a multi-byte UTF-8 character: bytes intact, boundary preserved', async () => {
    const { fx, report } = await runShape('res-stream-unicode-split')
    expectBoundaryIdentity(report, fx)
    const expected = Buffer.concat(fx.response.payloads)
    expect(report.sut.client.body.equals(expected)).toBe(true)
    // the delivered bytes are valid UTF-8 end to end: a decoder-based proxy would
    // have produced U+FFFD replacement characters at the split; byte forwarding cannot
    expect(report.sut.client.body.toString('utf8')).not.toContain('\uFFFD')
    expect(report.sut.client.body.toString('utf8')).toContain('🎯')
  }, 120_000)

  it('obfuscation padding survives on every chunk (byte presence per scripted payload)', async () => {
    const { fx, report } = await runShape('res-stream-obfuscation')
    expectBoundaryIdentity(report, fx)
    const delivered = report.sut.client.body
    for (const p of fx.response.payloads) {
      if (p.toString('utf8').includes('obfuscation')) {
        expect(delivered.includes(p), 'every obfuscated chunk arrives byte-identically').toBe(true)
      }
    }
  }, 120_000)

  it('reasoning_content fragments all survive, in order, byte-exact', async () => {
    const { fx, report } = await runShape('res-stream-reasoning')
    expectBoundaryIdentity(report, fx)
    const delivered = report.sut.client.body
    for (const p of fx.response.payloads) {
      expect(delivered.includes(p)).toBe(true)
    }
    const text = delivered.toString('utf8')
    const i1 = text.indexOf('Let me ')
    const i2 = text.indexOf('before answering.')
    expect(i1).toBeGreaterThan(-1)
    expect(i2).toBeGreaterThan(i1) // order preserved
  }, 120_000)

  it('parallel tool-call argument fragments survive byte-exact', async () => {
    const { fx, report } = await runShape('res-stream-parallel-tools')
    expectBoundaryIdentity(report, fx)
    const delivered = report.sut.client.body
    for (const p of fx.response.payloads) expect(delivered.includes(p)).toBe(true)
  }, 120_000)
})

describe('V4a — truncation shapes (no fabricated terminators, ever)', () => {
  it('mid-chunk abort: identical truncation offset and identical partial bytes', async () => {
    const { fx, report } = await runShape('res-abort-mid-chunk')
    const terminate = fx.response.script.terminate as { kind: 'destroy-after-body-bytes'; bodyBytes: number }
    expect(report.baseline.client.framingComplete).toBe(false)
    expect(report.sut.client.framingComplete).toBe(false)
    expect(report.sut.client.truncatedAtBodyByte).toBe(terminate.bodyBytes)
    expect(report.baseline.client.truncatedAtBodyByte).toBe(terminate.bodyBytes)
    const expectedPrefix = Buffer.concat(fx.response.payloads).subarray(0, terminate.bodyBytes)
    expect(report.sut.client.body.equals(expectedPrefix)).toBe(true)
    // no chunked terminator was invented: the decoded body simply stops
    expect(report.sut.client.body.length).toBe(terminate.bodyBytes)
  }, 120_000)

  it('interrupted before [DONE]: nothing terminal is invented', async () => {
    const { fx, report } = await runShape('res-stream-interrupted-no-done')
    expect(report.sut.client.framingComplete).toBe(false)
    const delivered = report.sut.client.body.toString('utf8')
    expect(delivered).not.toContain('[DONE]')
    expect(delivered).toBe(Buffer.concat(fx.response.payloads).toString('utf8'))
    expect(report.sut.client.truncatedAtBodyByte).toBe(report.baseline.client.truncatedAtBodyByte)
  }, 120_000)

  it('ORDERING: the truncation counter is consistent before the client can observe the close', async () => {
    // The A5 lesson as a streaming test: emit-at-decision, persist-after. If the
    // 'response-truncated' event were emitted after the finalize await, a client
    // closing fast could observe the truncated socket while stats still showed 0.
    const fx = await fixture('res-abort-mid-chunk')
    const sut = gatewaySut()
    const report = await runFidelityCheck({ fixture: fx, sut })
    // runClient resolved => the client socket fully closed => everything the client
    // could observe has happened. The counter must already agree.
    expect(sut.lastHandle()!.stats().responsesTruncated).toBe(1)
    expect(sut.lastHandle()!.stats().responsesComplete).toBe(0)
    expect(report.diffs).toEqual([])
  }, 120_000)
})

describe('V4a — client abort ordering (I1 + honest capture)', () => {
  it('client abort mid-stream: counted before observation ends, capture incomplete, upstream released', async () => {
    const fx = await fixture('res-stream-50ms-timing')
    const outDir = tempDir()
    const up = await startMockUpstream(fx.response.script, fx.response.payloads)
    const gw = await startGateway({
      upstreamOrigin: up.origin,
      rewriteHost: false,
      captureOutDir: outDir,
      listenPort: 0,
    })
    try {
      const client = await runClient({
        port: gw.port,
        headBytes: fx.request.headBytes,
        body: fx.request.body,
        timeoutMs: 30_000,
        abortAfterMs: 120, // mid-stream: 50ms cadence, dies around the third event
      })
      expect(client.aborted).toBe(true)
      expect(client.framingComplete).toBe(false)
      // ORDERING: the client socket is closed (runClient resolved), so the
      // client-aborted counter must already be incremented.
      expect(gw.stats().clientAborted).toBe(1)
      // and the capture is honest — wait is bounded because finalization is write-behind
      const ids = gw.captureIds()
      const meta = await waitMeta(path.join(outDir, ids[ids.length - 1]!))
      expect(meta.status).toBe('incomplete:client-aborted')
      expect(meta.response.truncated).toBe(true)
    } finally {
      await gw.stop()
      await up.stop()
    }
  }, 120_000)
})

describe('V4a — criterion sweep: EVERY streaming fixture preserves boundaries', () => {
  it('all chunked fixtures pass per-arrival boundary identity (dynamic list)', async () => {
    const all = await corpus()
    const streaming = all.filter((f) => f.response.script.framing === 'chunked')
    expect(streaming.length).toBeGreaterThanOrEqual(14) // corpus cannot silently shrink
    const failures: string[] = []
    for (const fx of streaming) {
      const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
      if (report.diffs.length > 0) {
        failures.push(`${fx.id}:\n${formatReport(report, { timelines: true })}`)
        continue
      }
      const b = report.baseline.client.bodyEvents.map((e) => e.bytes)
      const s = report.sut.client.bodyEvents.map((e) => e.bytes)
      if (JSON.stringify(b) !== JSON.stringify(s)) {
        failures.push(`${fx.id}: arrival byte-length sequence differs\n  baseline=${b.join(',')}\n  sut=${s.join(',')}`)
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([])
  }, 600_000)
})

describe('V4a — recording↔delivery agreement', () => {
  it('what the gateway RECORDED decodes to exactly what the client RECEIVED', async () => {
    const fx = await fixture('res-stream-reasoning')
    const r = await exchangeViaGateway(fx)
    expect(r.client.framingComplete).toBe(true)
    const wire = readFileSync(path.join(r.captureDir!, 'response.wire.bin'))
    // independent decode of the recorded wire with the rig's decoder
    const d = new ResponseDecoder()
    const recordedBody = d.feed(wire)
    d.socketEnded()
    expect(d.outcome).toBe('complete')
    expect(recordedBody.equals(r.client.body), 'recorded wire body == delivered body').toBe(true)
    expect(sha256(recordedBody)).toBe(r.client.bodySha256)
    // and both equal the scripted payloads — three independent views, one truth
    expect(recordedBody.equals(Buffer.concat(fx.response.payloads))).toBe(true)
  }, 120_000)

  it('the same holds for a TRUNCATED stream (partial record == partial delivery)', async () => {
    const fx = await fixture('res-abort-mid-chunk')
    const r = await exchangeViaGateway(fx)
    expect(r.client.framingComplete).toBe(false)
    const wire = readFileSync(path.join(r.captureDir!, 'response.wire.bin'))
    const d = new ResponseDecoder()
    const recordedBody = d.feed(wire)
    d.socketEnded()
    expect(d.outcome).toBe('truncated')
    expect(recordedBody.equals(r.client.body)).toBe(true)
    expect(r.meta!.status).toBe('incomplete:upstream-aborted')
  }, 120_000)
})
