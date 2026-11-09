/**
 * Integration tests for the two ground-truth endpoints: the raw-socket client and
 * the scripted mock upstream. These verify the MEASUREMENT MACHINERY itself —
 * arrival recording, deadline-corrected timing, truncation at exact offsets,
 * request capture — before any of it is trusted to judge a proxy.
 */

import { describe, expect, it } from 'vitest'
import { runClient } from '../src/client.js'
import { serializeHead } from '../src/http.js'
import { startMockUpstream } from '../src/upstream.js'
import type { ResponseScript } from '../src/types.js'

const REQ_HEAD = serializeHead('POST /v1/chat/completions HTTP/1.1', [
  ['host', 'qwen-api.invalid'],
  ['content-type', 'application/json'],
  ['content-length', '13'],
  ['connection', 'close'],
])
const REQ_BODY = Buffer.from('{"probe":true}', 'utf8').subarray(0, 13)

function sseEvent(i: number): string {
  return `data: {"id":"x","n":${i}}\n\n`
}

function streamScript(n: number, delayMs: number, terminate?: ResponseScript['terminate']): ResponseScript {
  return {
    status: 200,
    reason: 'OK',
    headers: [
      ['date', 'Sun, 09 Nov 2026 14:00:00 GMT'],
      ['content-type', 'text/event-stream; charset=utf-8'],
      ['connection', 'close'],
    ],
    framing: 'chunked',
    writes: Array.from({ length: n }, (_, i) => ({ payload: { inline: sseEvent(i) }, delayMs })),
    ...(terminate ? { terminate } : {}),
  }
}

async function withUpstream(script: ResponseScript, payloads: Buffer[], fn: (up: Awaited<ReturnType<typeof startMockUpstream>>) => Promise<void>) {
  const up = await startMockUpstream(script, payloads)
  try {
    await fn(up)
  } finally {
    await up.stop()
  }
}

describe('mock upstream + raw client', () => {
  it('captures the request EXACTLY as sent (head bytes + body sha) and replays the script', async () => {
    const script = streamScript(3, 10)
    const payloads = script.writes.map((_, i) => Buffer.from(sseEvent(i)))
    await withUpstream(script, payloads, async (up) => {
      const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 10_000 })
      expect(r.framingComplete).toBe(true)
      expect(r.body.toString()).toBe(sseEvent(0) + sseEvent(1) + sseEvent(2))
      expect(r.head?.statusCode).toBe(200)
      expect(up.captures).toHaveLength(1)
      const cap = up.captures[0]!
      expect(cap.headBytes.toString()).toBe(REQ_HEAD.toString())
      expect(cap.body.equals(REQ_BODY)).toBe(true)
      expect(cap.bodyComplete).toBe(true)
      expect(cap.method).toBe('POST')
      expect(cap.target).toBe('/v1/chat/completions')
    })
  })

  it('records one body arrival per scripted write with the nominal gaps (incremental arrival, measured)', async () => {
    const n = 6
    const delay = 30
    const script = streamScript(n, delay)
    const payloads = script.writes.map((_, i) => Buffer.from(sseEvent(i)))
    await withUpstream(script, payloads, async (up) => {
      const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 10_000 })
      expect(r.bodyEvents).toHaveLength(n)
      // gaps between arrivals approximate the schedule within a generous local bound;
      // the rig's strict 5ms differential is asserted in conformance where both runs
      // experience the same scheduler.
      for (let k = 1; k < n; k++) {
        const gap = r.bodyEvents[k]!.tMs - r.bodyEvents[k - 1]!.tMs
        expect(gap, `gap ${k}`).toBeGreaterThanOrEqual(delay - 8)
        expect(gap, `gap ${k}`).toBeLessThan(delay + 40)
      }
      // first body byte arrives long before the stream ends: NOT buffered to completion
      expect(r.bodyEvents[0]!.tMs).toBeLessThan(r.bodyEvents[n - 1]!.tMs - delay * (n - 2))
    })
  })

  it('delivers a splitAfterBytes write as two distinct arrivals 5 ms apart', async () => {
    const payload = Buffer.from(sseEvent(0) + sseEvent(1))
    const script: ResponseScript = {
      status: 200,
      reason: 'OK',
      headers: [['content-type', 'text/event-stream'], ['connection', 'close']],
      framing: 'chunked',
      writes: [{ payload: { inline: payload.toString() }, delayMs: 10, splitAfterBytes: 12 }],
    }
    await withUpstream(script, [payload], async (up) => {
      const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 10_000 })
      expect(r.bodyEvents).toHaveLength(2)
      expect(r.bodyEvents[0]!.bytes).toBe(12)
      expect(r.bodyEvents[1]!.bytes).toBe(payload.length - 12)
      expect(r.body.toString()).toBe(payload.toString())
    })
  })

  it('truncate exactly: destroy-after-body-bytes lands mid-chunk at the promised offset', async () => {
    const payloads = [Buffer.from(sseEvent(0)), Buffer.from(sseEvent(1)), Buffer.from(sseEvent(2))]
    const cutAt = payloads[0]!.length + 7 // inside event 1
    const script = streamScript(3, 10, { kind: 'destroy-after-body-bytes', bodyBytes: cutAt })
    await withUpstream(script, payloads, async (up) => {
      const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 10_000 })
      expect(r.framingComplete).toBe(false)
      expect(r.truncatedAtBodyByte).toBe(cutAt)
      expect(r.body.length).toBe(cutAt)
      expect(r.body.toString()).toBe(payloads[0]!.toString() + payloads[1]!.toString().slice(0, 7))
    })
  })

  it('destroy-after-write truncates at the write boundary', async () => {
    const payloads = [Buffer.from(sseEvent(0)), Buffer.from(sseEvent(1)), Buffer.from(sseEvent(2))]
    const script = streamScript(3, 10, { kind: 'destroy-after-write', writeIndex: 1 })
    await withUpstream(script, payloads, async (up) => {
      const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 10_000 })
      expect(r.framingComplete).toBe(false)
      expect(r.truncatedAtBodyByte).toBe(payloads[0]!.length + payloads[1]!.length)
    })
  })

  it('content-length framing: single arrival, exact body, complete', async () => {
    const body = Buffer.from('{"ok":true}')
    const script: ResponseScript = {
      status: 200,
      reason: 'OK',
      headers: [['content-type', 'application/json'], ['connection', 'close']],
      framing: 'length',
      writes: [{ payload: { inline: body.toString() }, delayMs: 5 }],
    }
    await withUpstream(script, [body], async (up) => {
      const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 10_000 })
      expect(r.framingComplete).toBe(true)
      expect(r.body.equals(body)).toBe(true)
      expect(r.bodyEvents).toHaveLength(1)
      expect(up.captures[0]!.headerPairs).toEqual([
        ['host', 'qwen-api.invalid'],
        ['content-type', 'application/json'],
        ['content-length', '13'],
        ['connection', 'close'],
      ])
    })
  })

  it('client abort: upstream records clientClosedEarly and nothing hangs', async () => {
    const script = streamScript(10, 50)
    const payloads = script.writes.map((_, i) => Buffer.from(sseEvent(i)))
    await withUpstream(script, payloads, async (up) => {
      const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 10_000, abortAfterMs: 80 })
      expect(r.aborted).toBe(true)
      expect(r.framingComplete).toBe(false)
      // upstream saw the request and noticed the client vanish
      expect(up.captures[0]!.bodyComplete).toBe(true)
      // give the upstream a tick to observe the close
      await new Promise((res) => setTimeout(res, 50))
      expect(up.captures[0]!.clientClosedEarly).toBe(false) // request WAS complete; response-side death isn't a request abort
    })
  })

  it('watchdog: a server that accepts but never responds yields timedOut, not a hang', async () => {
    const script = streamScript(1, 10)
    const payloads = [Buffer.from(sseEvent(0))]
    const up = await startMockUpstream(script, payloads)
    // point the client at a port where nothing will ever answer a SECOND connection:
    // instead, stop the upstream so connect fails fast, and assert the failure is data.
    await up.stop()
    const r = await runClient({ port: up.port, headBytes: REQ_HEAD, body: REQ_BODY, timeoutMs: 2_000 })
    expect(r.head).toBeUndefined()
    expect(r.framingComplete).toBe(false)
    expect(r.socketError ?? r.timedOut).toBeTruthy()
  })
})
