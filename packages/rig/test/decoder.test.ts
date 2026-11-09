/**
 * Unit tests for the incremental HTTP/1.1 decoder — the component that turns raw
 * socket bytes into (head, body-arrivals, framing outcome). Adversarial feed
 * boundaries are the point: a decoder that only works when frames arrive whole
 * would let a coalescing proxy hide behind its own buffering.
 */

import { describe, expect, it } from 'vitest'
import { HeadParser, ResponseDecoder } from '../src/http.js'

const HEAD = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nX-Dup: a\r\nx-dup: b\r\n'

describe('HeadParser', () => {
  it('parses status line and preserves duplicate headers in order with original casing', () => {
    const p = new HeadParser()
    const rest = p.feed(Buffer.from(`${HEAD}content-length: 5\r\n\r\nBODY!`, 'utf8'))
    expect(p.done).toBe(true)
    const r = p.result!
    expect(r.firstLine).toBe('HTTP/1.1 200 OK')
    expect(r.headers).toEqual([
      ['content-type', 'text/plain'],
      ['X-Dup', 'a'],
      ['x-dup', 'b'],
      ['content-length', '5'],
    ])
    expect(rest.toString()).toBe('BODY!')
  })

  it('works when the head arrives one byte at a time', () => {
    const p = new HeadParser()
    const full = Buffer.from(`${HEAD}\r\n`, 'utf8')
    let rest: Buffer = Buffer.alloc(0)
    for (let i = 0; i < full.length; i++) {
      const out = p.feed(full.subarray(i, i + 1))
      if (out.length > 0) rest = out
    }
    expect(p.done).toBe(true)
    expect(rest.length).toBe(0)
  })

  it('rejects obs-fold continuation lines instead of guessing', () => {
    const p = new HeadParser()
    expect(() => p.feed(Buffer.from('HTTP/1.1 200 OK\r\nx: a\r\n folded\r\n\r\n'))).toThrow(/obs-fold/)
  })
})

describe('ResponseDecoder — content-length framing', () => {
  it('decodes a body split across arbitrary feeds and reports completion', () => {
    const d = new ResponseDecoder()
    const head = Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\n', 'utf8')
    expect(d.feed(head).length).toBe(0)
    expect(d.head?.statusCode).toBe(200)
    expect(d.feed(Buffer.from('abc')).toString()).toBe('abc')
    expect(d.feed(Buffer.from('defgh')).toString()).toBe('defgh')
    expect(d.outcome).toBe('pending')
    expect(d.feed(Buffer.from('ij')).toString()).toBe('ij')
    expect(d.outcome).toBe('complete')
    expect(d.bodyByteCount).toBe(10)
  })

  it('treats FIN before content-length as truncation at the exact byte count', () => {
    const d = new ResponseDecoder()
    d.feed(Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc', 'utf8'))
    d.socketEnded()
    expect(d.outcome).toBe('truncated')
    expect(d.truncatedAtBodyByte).toBe(3)
  })

  it('counts post-completion bytes as excess (protocol violation detector)', () => {
    const d = new ResponseDecoder()
    d.feed(Buffer.from('HTTP/1.1 204 No Content\r\n\r\n', 'utf8'))
    expect(d.outcome).toBe('complete')
    d.feed(Buffer.from('surprise'))
    expect(d.excessBytes).toBe(8)
  })
})

describe('ResponseDecoder — chunked framing', () => {
  const chunkedHead = 'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n'
  const twoChunks = '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'

  it('decodes when everything arrives in one feed', () => {
    const d = new ResponseDecoder()
    const body = d.feed(Buffer.from(chunkedHead + twoChunks, 'utf8'))
    expect(body.toString()).toBe('hello world')
    expect(d.outcome).toBe('complete')
  })

  it('decodes when fed ONE BYTE AT A TIME (every frame boundary is split)', () => {
    const d = new ResponseDecoder()
    const full = Buffer.from(chunkedHead + twoChunks, 'utf8')
    const out: Buffer[] = []
    for (let i = 0; i < full.length; i++) {
      const piece = d.feed(full.subarray(i, i + 1))
      if (piece.length > 0) out.push(piece)
    }
    expect(Buffer.concat(out).toString()).toBe('hello world')
    expect(d.outcome).toBe('complete')
    // One-byte feeds of payload produce one arrival per payload byte: the decoder
    // never coalesces on its own — arrival granularity follows the feed granularity.
    expect(out.length).toBe(11)
  })

  it('handles chunk extensions and trailers', () => {
    const d = new ResponseDecoder()
    d.feed(Buffer.from(chunkedHead + '5;ext=1\r\nhello\r\n0\r\nx-trailer: v\r\n\r\n', 'utf8'))
    expect(d.bodyByteCount).toBe(5)
    expect(d.outcome).toBe('complete')
  })

  it('marks truncation when the socket dies mid-chunk (the abort-mid-chunk fixture shape)', () => {
    const d = new ResponseDecoder()
    // chunk size promises 11 bytes; only 4 arrive, then FIN.
    const body = d.feed(Buffer.from(chunkedHead + 'b\r\nhell', 'utf8'))
    expect(body.toString()).toBe('hell')
    d.socketEnded()
    expect(d.outcome).toBe('truncated')
    expect(d.truncatedAtBodyByte).toBe(4)
  })

  it('marks truncation when the terminator never arrives after complete frames', () => {
    const d = new ResponseDecoder()
    d.feed(Buffer.from(chunkedHead + '5\r\nhello\r\n', 'utf8'))
    expect(d.outcome).toBe('pending')
    d.socketEnded()
    expect(d.outcome).toBe('truncated')
    expect(d.truncatedAtBodyByte).toBe(5)
  })

  it('rejects a malformed chunk size line loudly', () => {
    const d = new ResponseDecoder()
    expect(() => d.feed(Buffer.from(chunkedHead + 'zz\r\nx', 'utf8'))).toThrow(/malformed chunk size/)
  })
})

describe('ResponseDecoder — close-delimited framing', () => {
  it('completes on socket end, body = everything', () => {
    const d = new ResponseDecoder()
    d.feed(Buffer.from('HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/html\r\n\r\n<html>nope</html>', 'utf8'))
    expect(d.outcome).toBe('pending')
    d.socketEnded()
    expect(d.outcome).toBe('complete')
    expect(d.bodyByteCount).toBe(17) // '<html>nope</html>' is 17 bytes
  })
})

describe('ResponseDecoder — status line parsing', () => {
  it('preserves multi-word reason phrases', () => {
    const d = new ResponseDecoder()
    d.feed(Buffer.from('HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\n\r\n', 'utf8'))
    expect(d.head?.statusCode).toBe(429)
    expect(d.head?.reason).toBe('Too Many Requests')
  })
})
