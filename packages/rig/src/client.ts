/**
 * Raw-socket HTTP/1.1 client for the fidelity rig.
 *
 * WHY RAW: the client must (a) put EXACT bytes on the wire — both runs of a fixture
 * send byte-identical requests, which is what makes "what did the upstream see" a
 * meaningful differential — and (b) observe the response as socket arrivals, before
 * any framework decoding/coalescing of its own. `fetch()`/undici would re-encode
 * request bodies and hide arrival boundaries; both are disqualifying here.
 *
 * The client records an arrival timeline of DECODED BODY bytes: one entry per socket
 * data event that carried at least one body byte (chunk framing consumed by the
 * incremental decoder, payload never parsed). That timeline is what lets the rig
 * assert incremental delivery and detect coalescing — comparing only final bytes
 * would pass a fully-buffered proxy.
 *
 * The rig buffers the body for byte-level diffing BY DESIGN (it is a test harness and
 * needs random access to compute diff regions). Hashing, in contrast, is incremental —
 * updated per arrival — mirroring the constraint production code lives under (bodies
 * exceed 10 MB at 1M-token context; a buffered hash there is not viable).
 *
 * Loopback-only: connects to 127.0.0.1, always. There is no code path in this package
 * that resolves a hostname.
 */

import { createHash } from 'node:crypto'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import { ResponseDecoder } from './http.js'
import type { ArrivalEvent, ClientResult } from './types.js'

export interface ClientRunOptions {
  port: number
  /** Exact request-line + headers bytes (CRLF-terminated, blank line included). */
  headBytes: Buffer
  /** Raw request body bytes; may be empty. */
  body?: Buffer
  /** Watchdog from socket connect to framing completion. Default 30_000 ms. */
  timeoutMs?: number
  /**
   * Fault injection: destroy our own socket this many ms after the request finished
   * writing (models a client abort mid-stream). The run resolves normally with
   * `aborted: true` and whatever was observed; callers assert on SUT-side effects.
   */
  abortAfterMs?: number
}

export const DEFAULT_CLIENT_TIMEOUT_MS = 30_000

export function runClient(opts: ClientRunOptions): Promise<ClientResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
  return new Promise<ClientResult>((resolve) => {
    const wireEvents: ArrivalEvent[] = []
    const bodyEvents: ArrivalEvent[] = []
    const bodyPieces: Buffer[] = []
    const hash = createHash('sha256')
    const decoder = new ResponseDecoder()

    let t0: number | undefined // request fully written (write callback fired)
    let wireCum = 0
    let bodyCum = 0
    let ttfbMs: number | undefined
    let timedOut = false
    let aborted = false
    let socketError: string | undefined
    let settled = false
    let requestBytesWritten = 0

    const socket = net.connect({ host: '127.0.0.1', port: opts.port })
    socket.setNoDelay(true)

    const watchdog = setTimeout(() => {
      timedOut = true
      socket.destroy()
    }, timeoutMs)

    let abortTimer: NodeJS.Timeout | undefined

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      if (abortTimer) clearTimeout(abortTimer)
      decoder.socketEnded()
      const framingComplete = decoder.outcome === 'complete'
      resolve({
        requestBytesWritten,
        wireEvents,
        head: decoder.head,
        bodyEvents,
        body: bodyPieces.length === 0 ? Buffer.alloc(0) : Buffer.concat(bodyPieces),
        bodySha256: hash.digest('hex'),
        ...(ttfbMs !== undefined ? { ttfbMs } : {}),
        framingComplete,
        ...(framingComplete ? {} : { truncatedAtBodyByte: decoder.bodyByteCount }),
        ...(socketError !== undefined ? { socketError } : {}),
        timedOut,
        aborted,
        totalMs: t0 !== undefined ? performance.now() - t0 : 0,
      })
    }

    socket.on('connect', () => {
      const out = opts.body && opts.body.length > 0 ? Buffer.concat([opts.headBytes, opts.body]) : opts.headBytes
      requestBytesWritten = out.length
      socket.write(out, () => {
        t0 = performance.now()
        if (opts.abortAfterMs !== undefined) {
          abortTimer = setTimeout(() => {
            aborted = true
            socket.destroy()
          }, opts.abortAfterMs)
        }
      })
    })

    socket.on('data', (data: Buffer) => {
      if (t0 === undefined) return // data before our write flushed: not expected; ignore defensively
      const tMs = performance.now() - t0
      if (ttfbMs === undefined) ttfbMs = tMs
      wireCum += data.length
      wireEvents.push({ tMs, bytes: data.length, cumBytes: wireCum })
      let decoded: Buffer
      try {
        decoded = decoder.feed(data)
      } catch (err) {
        socketError = `decoder: ${err instanceof Error ? err.message : String(err)}`
        socket.destroy()
        return
      }
      if (decoded.length > 0) {
        hash.update(decoded)
        bodyPieces.push(decoded)
        bodyCum += decoded.length
        bodyEvents.push({ tMs, bytes: decoded.length, cumBytes: bodyCum })
      }
      if (decoder.outcome === 'complete') {
        // Framing says we are done. Do not wait for the server to close (it may hold
        // the connection); half-close so keep-alive servers see EOF from us.
        socket.end()
      }
    })

    // Any socket error (incl. ECONNREFUSED before connect, ECONNRESET mid-stream) is
    // recorded as data, never as a rejection: a broken transport is an observation the
    // rig must report, not an exception that skips the report. 'close' follows and
    // finalises the result either way.
    socket.on('error', (err: Error & { code?: string }) => {
      if (socketError === undefined) socketError = err.code ?? err.message
    })

    socket.on('close', finish)
  })
}
