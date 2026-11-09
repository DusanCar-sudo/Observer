/**
 * Defensive-path tests for the session-id plugin — tested NOW, not in the live
 * run, because the live run is the one place a failure is expensive: the host
 * waterfall fails the inference call when a contributor throws (fail-CLOSED),
 * which conflicts with I1. Every case here asserts the same contract: the plugin
 * contributes nothing and lets the chain proceed, no exception escaping.
 */

import { describe, expect, it } from 'vitest'
import { apply, HEADER_NAME, onPiAiRequestHeaders, WATERFALL_EVENT } from '../plugin/observer-session-id.mjs'

/** Minimal fake cordis ctx that records registrations. */
function fakeCtx(): { registrations: [string, unknown][]; on: (n: string, l: unknown) => void } {
  const registrations: [string, unknown][] = []
  return {
    registrations,
    on(name: string, listener: unknown) {
      registrations.push([name, listener])
    },
  }
}

describe('apply (registration)', () => {
  it('registers exactly one listener on the documented waterfall event', () => {
    const ctx = fakeCtx()
    apply(ctx)
    expect(ctx.registrations).toHaveLength(1)
    expect(ctx.registrations[0]![0]).toBe(WATERFALL_EVENT)
    expect(ctx.registrations[0]![1]).toBe(onPiAiRequestHeaders)
  })

  it('survives a malformed ctx: on() throws', () => {
    expect(() =>
      apply({
        on() {
          throw new Error('host exploded')
        },
      }),
    ).not.toThrow()
  })

  it('survives a malformed ctx: on() missing / ctx nullish', () => {
    expect(() => apply({})).not.toThrow()
    expect(() => apply(undefined)).not.toThrow()
    expect(() => apply(null)).not.toThrow()
  })
})

describe('listener (per-request)', () => {
  it('sets exactly X-Observer-Session when sessionId is a non-empty string', () => {
    const headers = new Headers({ 'content-type': 'application/json', 'user-agent': 'dsh/1.0' })
    const nextCalls: number[] = []
    const result = onPiAiRequestHeaders({ provider: 'qwen', sessionId: 'sess-42' }, headers, () => {
      nextCalls.push(1)
      return headers
    })
    expect(headers.get(HEADER_NAME)).toBe('sess-42')
    expect(nextCalls).toHaveLength(1)
    expect(result).toBe(headers)
    // constraint 2: nothing else touched
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('user-agent')).toBe('dsh/1.0')
  })

  const badSessionIds: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['object', { toString: () => 'evil' }],
    ['empty string', ''],
    ['array', ['a']],
  ]
  for (const [label, sid] of badSessionIds) {
    it(`emits nothing when sessionId is ${label}`, () => {
      const headers = new Headers({ 'x-existing': 'v' })
      let nextCalled = false
      expect(() =>
        onPiAiRequestHeaders({ sessionId: sid }, headers, () => {
          nextCalled = true
          return headers
        }),
      ).not.toThrow()
      expect(headers.get(HEADER_NAME)).toBeNull()
      expect(headers.get('x-existing')).toBe('v')
      expect(nextCalled).toBe(true)
    })
  }

  it('emits nothing when request is nullish', () => {
    const headers = new Headers()
    let nextCalled = false
    expect(() =>
      onPiAiRequestHeaders(undefined, headers, () => {
        nextCalled = true
        return headers
      }),
    ).not.toThrow()
    expect(nextCalled).toBe(true)
    expect([...headers.keys()]).toEqual([])
  })

  it('survives a request whose sessionId getter THROWS', () => {
    const headers = new Headers()
    const hostile = {
      get sessionId(): string {
        throw new Error('getter boom')
      },
    }
    let nextCalled = false
    expect(() =>
      onPiAiRequestHeaders(hostile, headers, () => {
        nextCalled = true
        return headers
      }),
    ).not.toThrow()
    expect(nextCalled).toBe(true)
    expect(headers.get(HEADER_NAME)).toBeNull()
  })

  it('survives a Headers implementation that rejects set()', () => {
    const hostileHeaders = {
      set() {
        throw new TypeError('invalid header value')
      },
    }
    let nextCalled = false
    expect(() =>
      onPiAiRequestHeaders({ sessionId: 'sess-1' }, hostileHeaders, () => {
        nextCalled = true
        return 'downstream-result'
      }),
    ).not.toThrow()
    expect(nextCalled).toBe(true)
  })

  it('degrades to returning headers when next is not a function (host shape mismatch)', () => {
    const headers = new Headers()
    expect(() => onPiAiRequestHeaders({ sessionId: 'sess-1' }, headers, undefined)).not.toThrow()
    const out = onPiAiRequestHeaders({ sessionId: 'sess-1' }, headers, undefined)
    expect(out).toBe(headers)
  })

  it('PROPAGATES a downstream next() error (deliberate: not ours to swallow)', () => {
    // The host contract: a contributor exception fails the call with
    // REQUEST_HEADERS. If we swallowed another contributor's veto, we would
    // send a request that plugin tried to block — masking a real fault. This
    // test pins the interpretation stated in the plugin header comment.
    const headers = new Headers()
    expect(() =>
      onPiAiRequestHeaders({ sessionId: 'sess-1' }, headers, () => {
        throw new Error('downstream contributor failed')
      }),
    ).toThrow('downstream contributor failed')
  })
})
