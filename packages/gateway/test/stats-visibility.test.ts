/**
 * §9.1 condition 1 — COUNTED AND VISIBLE.
 *
 * "A number nobody reads repeats the warn-scope mistake" (FEEL warnings fired
 * 40k times in production and nothing surfaced them). These tests pin the
 * counter surface itself: snapshot isolation (callers cannot corrupt internal
 * state), the misdialect slot existing from day one at zero (milestone 1 has no
 * parser; the visible zero IS the claim "we saw nothing we did not
 * understand"), and the V3 feed hook working so the counter goes live without a
 * schema change.
 */

import { describe, expect, it } from 'vitest'
import { StatsCollector } from '../src/index.js'
import type { ProxyEvent } from '@observer/capture'

describe('stats surface', () => {
  it('starts all-zero with the misdialect slot present', () => {
    const s = new StatsCollector().snapshot()
    expect(s).toEqual({
      exchanges: 0,
      forwarded: 0,
      refused: {},
      responsesComplete: 0,
      responsesTruncated: 0,
      clientAborted: 0,
      upstreamConnectFailed: 0,
      captureErrors: 0,
      misdialectVerdicts: 0,
    })
  })

  it('counts every event kind', () => {
    const c = new StatsCollector()
    const events: ProxyEvent[] = [
      { kind: 'exchange-start', captureId: 'a', method: 'POST', target: '/v1/chat/completions' },
      { kind: 'forwarded', captureId: 'a' },
      { kind: 'response-complete', captureId: 'a', statusLine: 'HTTP/1.1 200 OK' },
      { kind: 'exchange-start', captureId: 'b', method: 'POST', target: '/v1/responses' },
      { kind: 'refused', captureId: 'b', reason: 'unsupported-path:/v1/responses', method: 'POST', target: '/v1/responses' },
      { kind: 'exchange-start', captureId: 'c', method: 'POST', target: '/v1/chat/completions' },
      { kind: 'forwarded', captureId: 'c' },
      { kind: 'response-truncated', captureId: 'c', status: 'incomplete:upstream-aborted', error: 'x' },
      { kind: 'client-aborted', captureId: 'd' },
      { kind: 'upstream-connect-failed', captureId: 'e', error: 'ECONNREFUSED' },
      { kind: 'capture-error', captureId: 'f', phase: 'recordResponseWire', error: 'ENOSPC' },
    ]
    for (const ev of events) c.onEvent(ev)
    const s = c.snapshot()
    expect(s.exchanges).toBe(3)
    expect(s.forwarded).toBe(2)
    expect(s.refused).toEqual({ 'unsupported-path:/v1/responses': 1 })
    expect(s.responsesComplete).toBe(1)
    expect(s.responsesTruncated).toBe(1)
    expect(s.clientAborted).toBe(1)
    expect(s.upstreamConnectFailed).toBe(1)
    expect(s.captureErrors).toBe(1)
  })

  it('snapshots are isolated — mutating a snapshot cannot corrupt the collector', () => {
    const c = new StatsCollector()
    c.onEvent({ kind: 'refused', captureId: 'x', reason: 'r', method: 'POST', target: '/t' })
    const s1 = c.snapshot()
    s1.refused['r'] = 999
    s1.forwarded = 42
    const s2 = c.snapshot()
    expect(s2.refused['r']).toBe(1)
    expect(s2.forwarded).toBe(0)
  })

  it('the V3 misdialect hook increments the visible counter', () => {
    const c = new StatsCollector()
    expect(c.snapshot().misdialectVerdicts).toBe(0)
    c.noteMisdialectVerdict()
    c.noteMisdialectVerdict()
    expect(c.snapshot().misdialectVerdicts).toBe(2)
  })
})
