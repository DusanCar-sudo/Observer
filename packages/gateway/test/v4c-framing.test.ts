/**
 * V4c — SSE FRAMING, [DONE], OBFUSCATION, COMPRESSION PASS-THROUGH.
 *
 * The payload edge cases that silently corrupt a stream, each as a NAMED test:
 *
 *  - an SSE event split across TCP writes AND across chunked-frame boundaries;
 *  - `data: [DONE]` forwarded exactly once and NEVER JSON-parsed (§4.3 — [DONE]
 *    is not JSON and parsing it throws; more fundamentally, the gateway contains
 *    no JSON codec at all — proven by the a2 source scan — so "never parsed"
 *    is structural, not a behavioural promise);
 *  - `obfuscation` preserved on every chunk (§4.1 — its only purpose is to be
 *    byte-present and sized, so dropping it is invisible to every semantic
 *    test; only byte comparison sees it);
 *  - compression passed through UNTOUCHED (spec §8: decompressing to observe and
 *    re-compressing breaks byte identity; the observation copy is derived and
 *    never re-serialised onto the wire);
 *  - NOTHING injected: no keepalive comments, no undocumented tokens (lead
 *    constraint — the round-2 [ASSUMPTION] downgrade stands; byte identity
 *    against the scripted payloads is itself the proof of non-injection).
 */

import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { formatReport, runFidelityCheck } from '@observer/rig'
import { fixture, gatewaySut } from './helpers.js'

async function throughGateway(id: string) {
  const fx = await fixture(id)
  const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
  if (report.diffs.length > 0) throw new Error(`\n${formatReport(report, { timelines: true })}`)
  return { fx, report }
}

describe('V4c — SSE events split across TCP writes AND chunked-frame boundaries', () => {
  it('delivers byte-identically when one event spans two chunked frames and another is split mid-frame', async () => {
    const { fx, report } = await throughGateway('res-stream-split-writes')
    const delivered = report.sut.client.body
    // the strongest statement: what the client received IS the concatenation of
    // the scripted payloads — byte-for-byte, splits and all
    expect(delivered.equals(Buffer.concat(fx.response.payloads))).toBe(true)
    // all six events survived as events (count of terminators — byte structure,
    // not parsing): nothing was glued or re-framed at the event level
    expect(delivered.toString('utf8').split('\n\n').length - 1).toBe(6)
    // and the arrival structure mirrors the scripted TCP-write structure
    expect(report.sut.client.bodyEvents.length).toBe(fx.response.expectedArrivals.length)
  }, 120_000)

  it('delivers byte-identically when a TCP write boundary lands inside a multi-byte UTF-8 character', async () => {
    const { fx, report } = await throughGateway('res-stream-unicode-split')
    expect(report.sut.client.body.equals(Buffer.concat(fx.response.payloads))).toBe(true)
    const text = report.sut.client.body.toString('utf8')
    expect(text).not.toContain('\uFFFD') // no replacement characters: no decode happened mid-stream
    expect(text).toContain('🎯') // the split emoji survived as bytes
  }, 120_000)
})

describe('V4c — data: [DONE] forwarded exactly once, never parsed', () => {
  it('exactly one [DONE], at the end, byte-identical', async () => {
    const { fx, report } = await throughGateway('res-stream-done')
    const text = report.sut.client.body.toString('utf8')
    expect(text.split('data: [DONE]').length - 1).toBe(1)
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    expect(report.sut.client.body.equals(Buffer.concat(fx.response.payloads))).toBe(true)
  }, 120_000)

  it('a truncated stream gets NO [DONE] and NO chunked terminator invented', async () => {
    const { fx, report } = await throughGateway('res-stream-interrupted-no-done')
    const text = report.sut.client.body.toString('utf8')
    expect(text).not.toContain('[DONE]')
    expect(report.sut.client.framingComplete).toBe(false)
    expect(report.sut.client.body.equals(Buffer.concat(fx.response.payloads))).toBe(true)
    // "never JSON-parsed" is structural: the a2 suite proves the gateway source
    // contains no JSON.parse/JSON.stringify at all — [DONE] could not be parsed
    // even by accident. (Parsing it would throw: [DONE] is not JSON, §4.3.)
  }, 120_000)
})

describe('V4c — NAMED REGRESSION: obfuscation preserved on every chunk (§4.1)', () => {
  it('every obfuscation value arrives byte-identically — the field whose only purpose is to exist', async () => {
    const { fx, report } = await throughGateway('res-stream-obfuscation')
    const delivered = report.sut.client.body.toString('utf8')
    // Extract each chunk's obfuscation value from the SCRIPTED payloads (test-side
    // parsing is fine — the gateway does none) and assert byte presence on the wire.
    let checked = 0
    for (const p of fx.response.payloads) {
      const m = /"obfuscation":"([^"]*)"/.exec(p.toString('utf8'))
      if (!m) continue
      checked++
      expect(delivered).toContain(`"obfuscation":"${m[1]}"`)
    }
    expect(checked).toBeGreaterThanOrEqual(5) // the fixture scripts obfuscation on every chunk
    // and the whole body is byte-identical anyway — the strongest form of the claim
    expect(report.sut.client.body.equals(Buffer.concat(fx.response.payloads))).toBe(true)
  }, 120_000)

  it('SseRewritingPipe (the typed-parse sin) WOULD drop it — the rig catches that double, proving this test has teeth', async () => {
    // The detection half of "invisible to every other test": run the same fixture
    // through the faulty double and require the obfuscation bytes to be flagged
    // missing by the byte diff. Without this, the named regression could pass
    // vacuously.
    const { SseRewritingPipe } = await import('@observer/rig')
    const fx = await fixture('res-stream-obfuscation')
    const report = await runFidelityCheck({ fixture: fx, sut: SseRewritingPipe })
    expect(report.passed).toBe(false)
    const bodyDiff = report.diffs.find((d) => d.kind === 'response-body-bytes')
    expect(bodyDiff, 'the rewriting double must be caught on body bytes').toBeDefined()
    expect(report.sut.client.body.toString('utf8')).not.toContain('obfuscation')
  }, 120_000)
})

describe('V4c — compression pass-through untouched (spec §8 decision)', () => {
  it('gzip: content-encoding preserved, compressed bytes byte-identical, decompression happens nowhere on the path', async () => {
    const { fx, report } = await throughGateway('res-gzip-nonstream')
    const headers = new Map(report.sut.client.head!.headers.map(([n, v]) => [n.toLowerCase(), v]))
    expect(headers.get('content-encoding')).toBe('gzip')
    const gzPayload = fx.response.payloads[0]!
    expect(report.sut.client.body.equals(gzPayload), 'compressed bytes delivered verbatim').toBe(true)
    // sanity that the payload really is gzip and really carries the provider JSON:
    // the OBSERVATION copy (decompressed, derived, off the wire path) is a lossless step
    expect(gzPayload[0]).toBe(0x1f)
    expect(gzPayload[1]).toBe(0x8b)
    expect(gunzipSync(gzPayload).toString('utf8')).toContain('chat.completion')
  }, 120_000)

  it('brotli: same contract, content-encoding: br', async () => {
    const { fx, report } = await throughGateway('res-br-nonstream')
    const headers = new Map(report.sut.client.head!.headers.map(([n, v]) => [n.toLowerCase(), v]))
    expect(headers.get('content-encoding')).toBe('br')
    const brPayload = fx.response.payloads[0]!
    expect(report.sut.client.body.equals(brPayload)).toBe(true)
    expect(brotliDecompressSync(brPayload).toString('utf8')).toContain('chat.completion')
  }, 120_000)
})

describe('V4c — nothing is injected into a supervised stream', () => {
  it('delivered bytes == scripted bytes across every streaming fixture: no keepalive comments, no undocumented tokens', async () => {
    // The lead constraint: `: keepalive` stays [ASSUMPTION]-gated and OFF. Byte
    // identity against the scripted payloads proves non-injection for the whole
    // streaming corpus in one sweep — anything the gateway added would break it.
    const { corpus } = await import('./helpers.js')
    const all = await corpus()
    const streaming = all.filter((f) => f.response.script.framing === 'chunked')
    expect(streaming.length).toBeGreaterThanOrEqual(14)
    for (const fx of streaming) {
      ;(globalThis as { gc?: () => void }).gc?.() // GC hygiene: out of the measurement window
      const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
      if (report.diffs.length > 0) throw new Error(`${fx.id}:\n${formatReport(report, { timelines: true })}`)
      const expected = Buffer.concat(fx.response.payloads)
      if (fx.response.script.terminate?.kind === 'destroy-after-body-bytes') {
        expect(report.sut.client.body.equals(expected.subarray(0, fx.response.script.terminate.bodyBytes))).toBe(true)
      } else if (fx.response.script.terminate?.kind === 'destroy-after-write') {
        // truncated at a write boundary: delivered bytes are a prefix of scripted bytes
        expect(expected.subarray(0, report.sut.client.body.length).equals(report.sut.client.body)).toBe(true)
      } else {
        expect(report.sut.client.body.equals(expected), `${fx.id}: delivered != scripted (injection or loss)`).toBe(true)
      }
      // explicit keepalive scan: no SSE comment lines anywhere in delivered bytes
      expect(report.sut.client.body.toString('utf8')).not.toMatch(/\n:[^\n]/)
    }
  }, 600_000)
})
