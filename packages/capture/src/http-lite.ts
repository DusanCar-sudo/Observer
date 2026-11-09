/**
 * Byte-level HTTP/1.1 primitives for the tap.
 *
 * Deliberately NOT shared with @observer/rig: the rig is the JUDGE and capture is
 * the thing judged — importing the judge's internals into the witness would let a
 * shared bug hide from the differential. These are independent implementations of
 * the same wire facts (head parsing, framing observation, Host splicing); if they
 * ever disagree, a conformance run fails loudly, which is the point.
 *
 * Nothing here decodes, re-encodes, or re-serialises a body. Observation only.
 */

export interface ParsedHead {
  firstLine: string
  /** Raw byte offsets of each header line: [start, end) including CRLF, plus name range. */
  headers: { name: string; nameStart: number; valueStart: number; lineEnd: number }[]
  /** Total head length including the final CRLF. */
  length: number
}

const CRLFCRLF = Buffer.from('\r\n\r\n')

/**
 * Locate the head in a byte buffer WITHOUT copying or transforming it.
 * Returns undefined when the blank line has not arrived yet.
 */
export function findHead(buf: Buffer): ParsedHead | undefined {
  const end = buf.indexOf(CRLFCRLF)
  if (end === -1) return undefined
  const headText = buf.subarray(0, end).toString('latin1')
  const lines = headText.split('\r\n')
  const firstLine = lines.shift() ?? ''
  const headers: ParsedHead['headers'] = []
  let pos = firstLine.length + 2
  for (const line of lines) {
    const c = line.indexOf(':')
    if (c !== -1) {
      const name = line.slice(0, c)
      let valueOffset = c + 1
      if (line[valueOffset] === ' ') valueOffset++
      headers.push({ name, nameStart: pos, valueStart: pos + valueOffset, lineEnd: pos + line.length })
    }
    pos += line.length + 2
  }
  return { firstLine, headers, length: end + 4 }
}

/**
 * Splice ONLY the Host header value, at the byte level. Every other byte of the
 * head is preserved verbatim — this is the single mutation the tap performs when
 * forwarding to a real provider (which rejects foreign Host values), and both the
 * as-received and forwarded heads are recorded so the splice is auditable.
 * If no Host header exists, one is inserted immediately after the request line.
 */
export function spliceHostHeader(rawHead: Buffer, newHostValue: string): { head: Buffer; changed: boolean } {
  const parsed = findHead(rawHead)
  if (!parsed) return { head: rawHead, changed: false }
  const hostEntry = parsed.headers.find((h) => h.name.toLowerCase() === 'host')
  const newValue = Buffer.from(newHostValue, 'latin1')
  if (hostEntry) {
    const before = rawHead.subarray(0, hostEntry.valueStart)
    const after = rawHead.subarray(hostEntry.lineEnd)
    const current = rawHead.subarray(hostEntry.valueStart, hostEntry.lineEnd)
    if (current.equals(newValue)) return { head: rawHead, changed: false }
    return { head: Buffer.concat([before, newValue, after]), changed: true }
  }
  const firstLineEnd = parsed.firstLine.length + 2
  const insert = Buffer.concat([Buffer.from('Host: ', 'latin1'), newValue, Buffer.from('\r\n', 'latin1')])
  return {
    head: Buffer.concat([rawHead.subarray(0, firstLineEnd), insert, rawHead.subarray(firstLineEnd)]),
    changed: true,
  }
}

/** Find a header's value in a parsed head (first match, case-insensitive). */
export function headValue(parsed: ParsedHead, rawHead: Buffer, name: string): string | undefined {
  const h = parsed.headers.find((x) => x.name.toLowerCase() === name.toLowerCase())
  if (!h) return undefined
  return rawHead.subarray(h.valueStart, h.lineEnd).toString('latin1')
}

export type FramingMode = 'chunked' | 'length' | 'close' | 'none'

/**
 * Incremental OBSERVER of response framing. It never alters or re-emits bytes; it
 * only answers "has the response ended?" so the tap can (a) stop recording,
 * (b) decide keep-alive on the client side, and (c) mark truncation honestly.
 * 'none' framing = 204/304-style: complete at head.
 */
export class ResponseFramer {
  #mode: FramingMode | undefined
  #remaining = 0
  #chunkState: 'size' | 'data' | 'crlf' | 'trailer' = 'size'
  #chunkRemaining = 0
  #partial: Buffer = Buffer.alloc(0)
  #complete = false
  #statusLine: string | undefined

  get complete(): boolean {
    return this.#complete
  }

  get statusLine(): string | undefined {
    return this.#statusLine
  }

  get mode(): FramingMode | undefined {
    return this.#mode
  }

  /** Feed raw wire bytes (as received from upstream). Observation only. */
  feed(data: Buffer): void {
    if (this.#complete) return
    let buf = this.#partial.length === 0 ? data : Buffer.concat([this.#partial, data])
    this.#partial = Buffer.alloc(0)

    if (this.#mode === undefined) {
      const parsed = findHead(buf)
      if (!parsed) {
        this.#partial = Buffer.from(buf)
        return
      }
      this.#statusLine = parsed.firstLine
      const code = Number(parsed.firstLine.split(' ')[1])
      const te = parsed.headers.find((h) => h.name.toLowerCase() === 'transfer-encoding')
      const cl = parsed.headers.find((h) => h.name.toLowerCase() === 'content-length')
      if (code === 204 || code === 304) {
        this.#mode = 'none'
        this.#complete = true
        return
      }
      if (te && buf.subarray(te.valueStart, te.lineEnd).toString('latin1').toLowerCase().includes('chunked')) {
        this.#mode = 'chunked'
      } else if (cl) {
        this.#mode = 'length'
        this.#remaining = Number(buf.subarray(cl.valueStart, cl.lineEnd).toString('latin1'))
        if (this.#remaining === 0) this.#complete = true
      } else {
        this.#mode = 'close'
      }
      buf = buf.subarray(parsed.length)
      if (this.#complete || buf.length === 0) return
    }

    if (this.#mode === 'length') {
      const take = Math.min(this.#remaining, buf.length)
      this.#remaining -= take
      if (this.#remaining === 0) this.#complete = true
      return
    }
    if (this.#mode === 'close' || this.#mode === 'none') {
      return // completes on FIN (handled by caller via markSocketEnd)
    }
    // chunked
    for (;;) {
      if (this.#chunkState === 'size') {
        const idx = buf.indexOf('\r\n')
        if (idx === -1) break
        const sizeLine = buf.subarray(0, idx).toString('latin1')
        const semi = sizeLine.indexOf(';')
        const sizeHex = (semi === -1 ? sizeLine : sizeLine.slice(0, semi)).trim()
        const size = Number.parseInt(sizeHex, 16)
        if (!Number.isFinite(size) || size < 0) {
          // Unparseable framing: stop observing; the tap forwards bytes regardless.
          this.#mode = 'close'
          return
        }
        buf = buf.subarray(idx + 2)
        if (size === 0) this.#chunkState = 'trailer'
        else {
          this.#chunkRemaining = size
          this.#chunkState = 'data'
        }
        continue
      }
      if (this.#chunkState === 'data') {
        if (buf.length === 0) break
        const take = Math.min(this.#chunkRemaining, buf.length)
        this.#chunkRemaining -= take
        buf = buf.subarray(take)
        if (this.#chunkRemaining === 0) this.#chunkState = 'crlf'
        continue
      }
      if (this.#chunkState === 'crlf') {
        if (buf.length < 2) break
        buf = buf.subarray(2)
        this.#chunkState = 'size'
        continue
      }
      // trailer
      const idx = buf.indexOf('\r\n')
      if (idx === -1) break
      if (idx === 0) {
        this.#complete = true
        return
      }
      buf = buf.subarray(idx + 2)
    }
    if (buf.length > 0) this.#partial = Buffer.from(buf)
  }

  /** FIN from upstream: close-delimited bodies complete; anything else was truncated. */
  markSocketEnd(): void {
    if (this.#mode === 'close') this.#complete = true
  }
}
