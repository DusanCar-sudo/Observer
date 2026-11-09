/**
 * Minimal HTTP/1.1 byte-level primitives shared by the rig's raw client, raw mock
 * upstream, and incremental decoder.
 *
 * Everything here operates on Buffers and ordered header pair lists — never on parsed
 * JSON documents. There is deliberately no helper in this package that turns a body
 * into an object on any comparison path.
 */

import type { DecodedHead, HeaderPairs } from './types.js'

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) plus the proxy-* family named in the V1/A4
 * criterion. These are per-connection and a faithful proxy MUST NOT forward them
 * verbatim, so header comparisons ignore exactly this set — and nothing else.
 * 'date' is NOT ignored: fixtures pin a deterministic Date so it can be compared
 * strictly, which catches a SUT that fabricates its own.
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]

export function isHopByHop(name: string): boolean {
  const n = name.toLowerCase()
  return HOP_BY_HOP_HEADERS.includes(n) || n.startsWith('proxy-')
}

/** Pair an IncomingMessage.rawHeaders flat array into ordered pairs. */
export function rawHeaderPairs(rawHeaders: string[]): HeaderPairs {
  const out: HeaderPairs = []
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    out.push([rawHeaders[i] as string, rawHeaders[i + 1] as string])
  }
  return out
}

export function findHeader(pairs: HeaderPairs, name: string): string | undefined {
  const n = name.toLowerCase()
  for (const [k, v] of pairs) if (k.toLowerCase() === n) return v
  return undefined
}

export function findAllHeaders(pairs: HeaderPairs, name: string): string[] {
  const n = name.toLowerCase()
  return pairs.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v)
}

/** Serialize a request/status line + header pairs + blank line to exact wire bytes. */
export function serializeHead(firstLine: string, headers: HeaderPairs): Buffer {
  let s = `${firstLine}\r\n`
  for (const [n, v] of headers) s += `${n}: ${v}\r\n`
  s += '\r\n'
  return Buffer.from(s, 'utf8')
}

const HEAD_END = Buffer.from('\r\n\r\n')

/**
 * Incremental head parser: feed socket bytes until the blank line arrives.
 * Works for both request heads and response heads; the caller interprets `firstLine`.
 */
export class HeadParser {
  #buf: Buffer = Buffer.alloc(0)
  #result: { firstLine: string; headers: HeaderPairs; headByteLength: number } | undefined

  get done(): boolean {
    return this.#result !== undefined
  }

  get headByteLength(): number {
    return this.#result?.headByteLength ?? 0
  }

  get result(): { firstLine: string; headers: HeaderPairs; headByteLength: number } | undefined {
    return this.#result
  }

  /** Returns the bytes of `data` that belong BEYOND the head (empty until head completes). */
  feed(data: Buffer): Buffer {
    if (this.#result) return data
    this.#buf = this.#buf.length === 0 ? data : Buffer.concat([this.#buf, data])
    const idx = this.#buf.indexOf(HEAD_END)
    if (idx === -1) {
      if (this.#buf.length > 1024 * 1024) throw new Error('head exceeds 1 MiB — not an HTTP/1.1 head')
      return Buffer.alloc(0)
    }
    const headText = this.#buf.subarray(0, idx).toString('latin1')
    const lines = headText.split('\r\n')
    const firstLine = lines.shift() ?? ''
    const headers: HeaderPairs = []
    for (const line of lines) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        throw new Error(`obs-fold continuation lines are not supported by the rig: ${JSON.stringify(line)}`)
      }
      const c = line.indexOf(':')
      if (c === -1) throw new Error(`malformed header line: ${JSON.stringify(line)}`)
      const name = line.slice(0, c)
      let value = line.slice(c + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      headers.push([name, value])
    }
    const rest = this.#buf.subarray(idx + 4)
    this.#result = { firstLine, headers, headByteLength: idx + 4 }
    this.#buf = Buffer.alloc(0)
    return rest
  }
}

/** Parse a response status line: `HTTP/1.1 200 OK` (reason may contain spaces, may be empty). */
export function parseStatusLine(line: string): { httpVersion: string; statusCode: number; reason: string } {
  const m = /^(HTTP\/\d\.\d) (\d{3})(?: (.*))?$/.exec(line)
  if (!m) throw new Error(`malformed status line: ${JSON.stringify(line)}`)
  return { httpVersion: m[1] as string, statusCode: Number(m[2]), reason: m[3] ?? '' }
}

/** Parse a request line: `POST /v1/chat/completions HTTP/1.1`. */
export function parseRequestLine(line: string): { method: string; target: string; httpVersion: string } {
  const parts = line.split(' ')
  if (parts.length !== 3) throw new Error(`malformed request line: ${JSON.stringify(line)}`)
  return { method: parts[0] as string, target: parts[1] as string, httpVersion: parts[2] as string }
}

export function toDecodedHead(
  firstLine: string,
  headers: HeaderPairs,
  headByteLength: number,
  kind: 'response',
): DecodedHead
export function toDecodedHead(
  firstLine: string,
  headers: HeaderPairs,
  headByteLength: number,
  kind: 'request',
): DecodedHead & { method: string; target: string }
export function toDecodedHead(
  firstLine: string,
  headers: HeaderPairs,
  headByteLength: number,
  kind: 'response' | 'request',
): DecodedHead {
  if (kind === 'response') {
    const s = parseStatusLine(firstLine)
    return { httpVersion: s.httpVersion, statusCode: s.statusCode, reason: s.reason, headers, headByteLength }
  }
  const r = parseRequestLine(firstLine)
  return { httpVersion: r.httpVersion, method: r.method, target: r.target, headers, headByteLength }
}

/**
 * Incremental HTTP/1.1 response decoder.
 *
 * Feed raw socket bytes; it returns whatever DECODED BODY bytes that feed produced
 * (chunk framing consumed, boundaries of the feed preserved). This is what lets the
 * rig build an arrival timeline of body bytes without ever parsing the payload.
 *
 * Body framing modes: content-length, chunked (incl. trailers and frames split across
 * any number of feeds), and close-delimited. A socket FIN before framing completes
 * yields outcome 'truncated' with an exact byte count — the truncation semantics the
 * abort fixtures assert on.
 */
export class ResponseDecoder {
  #head = new HeadParser()
  #headDecoded: DecodedHead | undefined
  #mode: 'length' | 'chunked' | 'close' | undefined
  #remaining = 0 // length mode
  #chunkState: 'size' | 'data' | 'crlf' | 'trailer' = 'size'
  #chunkRemaining = 0
  #partial: Buffer = Buffer.alloc(0)
  #bodyByteCount = 0
  #outcome: 'pending' | 'complete' | 'truncated' = 'pending'
  #socketEnded = false
  #excessBytes = 0

  get head(): DecodedHead | undefined {
    return this.#headDecoded
  }

  get outcome(): 'pending' | 'complete' | 'truncated' {
    return this.#outcome
  }

  get bodyByteCount(): number {
    return this.#bodyByteCount
  }

  /** Bytes seen beyond the declared framing (protocol violation counter; informational). */
  get excessBytes(): number {
    return this.#excessBytes
  }

  /** Feed one socket data event. Returns decoded body bytes produced by THIS feed (may be empty). */
  feed(data: Buffer): Buffer {
    if (this.#outcome === 'complete') {
      this.#excessBytes += data.length
      return Buffer.alloc(0)
    }
    let rest = data
    if (!this.#headDecoded) {
      rest = this.#head.feed(data)
      if (!this.#head.done) return Buffer.alloc(0)
      const raw = this.#head.result!
      this.#headDecoded = toDecodedHead(raw.firstLine, raw.headers, raw.headByteLength, 'response')
      const te = findHeader(this.#headDecoded.headers, 'transfer-encoding')
      const cl = findHeader(this.#headDecoded.headers, 'content-length')
      if (te !== undefined && te.toLowerCase().includes('chunked')) {
        this.#mode = 'chunked'
      } else if (cl !== undefined) {
        this.#mode = 'length'
        this.#remaining = Number(cl)
        if (!Number.isInteger(this.#remaining) || this.#remaining < 0) {
          throw new Error(`invalid content-length: ${JSON.stringify(cl)}`)
        }
        if (this.#remaining === 0) this.#outcome = 'complete'
      } else {
        this.#mode = 'close'
      }
    }
    if (this.#outcome === 'complete') {
      this.#excessBytes += rest.length
      return Buffer.alloc(0)
    }
    if (rest.length === 0) return Buffer.alloc(0)

    if (this.#mode === 'length') {
      const take = Math.min(this.#remaining, rest.length)
      const body = rest.subarray(0, take)
      this.#remaining -= take
      this.#bodyByteCount += take
      if (this.#remaining === 0) this.#outcome = 'complete'
      if (rest.length > take) this.#excessBytes += rest.length - take
      return Buffer.from(body)
    }
    if (this.#mode === 'close') {
      this.#bodyByteCount += rest.length
      return Buffer.from(rest)
    }
    return this.#feedChunked(rest)
  }

  #feedChunked(input: Buffer): Buffer {
    let buf = this.#partial.length === 0 ? input : Buffer.concat([this.#partial, input])
    this.#partial = Buffer.alloc(0)
    const out: Buffer[] = []

    for (;;) {
      if (this.#chunkState === 'size') {
        const idx = buf.indexOf('\r\n')
        if (idx === -1) break
        const sizeLine = buf.subarray(0, idx).toString('latin1')
        const semi = sizeLine.indexOf(';')
        const sizeHex = (semi === -1 ? sizeLine : sizeLine.slice(0, semi)).trim()
        const size = Number.parseInt(sizeHex, 16)
        if (!Number.isFinite(size) || size < 0 || !/^[0-9a-fA-F]*$/.test(sizeHex)) {
          throw new Error(`malformed chunk size line: ${JSON.stringify(sizeLine)}`)
        }
        buf = buf.subarray(idx + 2)
        if (size === 0) {
          this.#chunkState = 'trailer'
        } else {
          this.#chunkRemaining = size
          this.#chunkState = 'data'
        }
        continue
      }
      if (this.#chunkState === 'data') {
        if (buf.length === 0) break
        const take = Math.min(this.#chunkRemaining, buf.length)
        out.push(Buffer.from(buf.subarray(0, take)))
        this.#bodyByteCount += take
        this.#chunkRemaining -= take
        buf = buf.subarray(take)
        if (this.#chunkRemaining === 0) this.#chunkState = 'crlf'
        continue
      }
      if (this.#chunkState === 'crlf') {
        if (buf.length < 2) break
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
          throw new Error(`missing CRLF after chunk data (got ${buf[0]}, ${buf[1]})`)
        }
        buf = buf.subarray(2)
        this.#chunkState = 'size'
        continue
      }
      // trailer section: header lines until an empty line.
      {
        const idx = buf.indexOf('\r\n')
        if (idx === -1) break
        if (idx === 0) {
          buf = buf.subarray(2)
          this.#outcome = 'complete'
          break
        }
        // A trailer line; consume and ignore (fixtures carry none, but tolerate them).
        buf = buf.subarray(idx + 2)
        continue
      }
    }

    if (buf.length > 0) this.#partial = Buffer.from(buf)
    if (out.length === 0) return Buffer.alloc(0)
    return out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out)
  }

  /**
   * Signal socket FIN. For close-delimited bodies that completes the framing; for
   * length/chunked it marks the response truncated at the exact decoded byte count.
   */
  socketEnded(): void {
    this.#socketEnded = true
    if (this.#outcome === 'complete') return
    if (this.#mode === 'close' && this.#headDecoded) {
      this.#outcome = 'complete'
      return
    }
    if (this.#headDecoded) this.#outcome = 'truncated'
  }

  get socketEndedFlag(): boolean {
    return this.#socketEnded
  }

  get truncatedAtBodyByte(): number | undefined {
    return this.#outcome === 'truncated' ? this.#bodyByteCount : undefined
  }
}
