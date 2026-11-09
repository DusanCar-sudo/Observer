/**
 * Unit tests for the tap's byte-level HTTP primitives: head finding, the Host
 * splice (the tap's single allowed mutation — it must be surgically minimal),
 * and the response framing OBSERVER (which must never alter bytes, only know
 * when a response ended).
 */

import { describe, expect, it } from 'vitest'
import { findHead, headValue, ResponseFramer, spliceHostHeader } from '../src/http-lite.js'

const HEAD = Buffer.from(
  'POST /v1/chat/completions HTTP/1.1\r\nHost: qwen-api.invalid\r\ncontent-type: application/json\r\ncontent-length: 5\r\n\r\nhello',
  'latin1',
)

describe('findHead', () => {
  it('locates head boundary and header value ranges without copying', () => {
    const parsed = findHead(HEAD)!
    expect(parsed.firstLine).toBe('POST /v1/chat/completions HTTP/1.1')
    expect(headValue(parsed, HEAD, 'host')).toBe('qwen-api.invalid')
    expect(headValue(parsed, HEAD, 'Content-Length')).toBe('5')
    expect(parsed.length).toBe(HEAD.indexOf('\r\n\r\n') + 4)
  })

  it('returns undefined until the blank line arrives', () => {
    expect(findHead(HEAD.subarray(0, 40))).toBeUndefined()
  })
})

describe('spliceHostHeader', () => {
  it('replaces only the Host value bytes; every other byte is identical', () => {
    const { head, changed } = spliceHostHeader(HEAD, 'real.provider.example:443')
    expect(changed).toBe(true)
    expect(head.toString('latin1')).toBe(
      HEAD.toString('latin1').replace('qwen-api.invalid', 'real.provider.example:443'),
    )
    // surgical: prefix and suffix around the value are byte-identical
    const valueStart = HEAD.indexOf('qwen-api.invalid')
    expect(head.subarray(0, valueStart).equals(HEAD.subarray(0, valueStart))).toBe(true)
  })

  it('matches Host case-insensitively and preserves the original header name casing', () => {
    const h = Buffer.from('GET / HTTP/1.1\r\nHoSt: a.invalid\r\nx: y\r\n\r\n', 'latin1')
    const { head } = spliceHostHeader(h, 'b.example')
    expect(head.toString('latin1')).toContain('HoSt: b.example\r\n')
  })

  it('is a no-op when the value already matches', () => {
    const { head, changed } = spliceHostHeader(HEAD, 'qwen-api.invalid')
    expect(changed).toBe(false)
    expect(head).toBe(HEAD) // same buffer object — literally untouched
  })

  it('inserts Host after the request line when absent', () => {
    const h = Buffer.from('GET /x HTTP/1.1\r\naccept: */*\r\n\r\n', 'latin1')
    const { head, changed } = spliceHostHeader(h, 'up.example')
    expect(changed).toBe(true)
    expect(head.toString('latin1')).toBe('GET /x HTTP/1.1\r\nHost: up.example\r\naccept: */*\r\n\r\n')
  })
})

describe('ResponseFramer (observation only)', () => {
  it('completes on content-length satisfaction', () => {
    const f = new ResponseFramer()
    f.feed(Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhel', 'latin1'))
    expect(f.complete).toBe(false)
    f.feed(Buffer.from('lo', 'latin1'))
    expect(f.complete).toBe(true)
    expect(f.statusLine).toBe('HTTP/1.1 200 OK')
  })

  it('completes on chunked terminator, fed one byte at a time', () => {
    const f = new ResponseFramer()
    const full = Buffer.from('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n', 'latin1')
    for (let i = 0; i < full.length; i++) f.feed(full.subarray(i, i + 1))
    expect(f.complete).toBe(true)
    expect(f.mode).toBe('chunked')
  })

  it('204 completes at the head', () => {
    const f = new ResponseFramer()
    f.feed(Buffer.from('HTTP/1.1 204 No Content\r\nx: y\r\n\r\n', 'latin1'))
    expect(f.complete).toBe(true)
    expect(f.mode).toBe('none')
  })

  it('close-delimited completes only on FIN, and stays incomplete otherwise (truncation truth)', () => {
    const f = new ResponseFramer()
    f.feed(Buffer.from('HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/html\r\n\r\n<html>x', 'latin1'))
    expect(f.complete).toBe(false)
    f.markSocketEnd()
    expect(f.complete).toBe(true)
  })

  it('chunked stream without terminator stays incomplete even after FIN', () => {
    const f = new ResponseFramer()
    f.feed(Buffer.from('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhel', 'latin1'))
    f.markSocketEnd()
    expect(f.complete).toBe(false)
  })
})
