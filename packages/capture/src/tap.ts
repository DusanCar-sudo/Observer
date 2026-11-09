/**
 * The V0a logging tap: a transparent recorder between a DSH agent and its provider.
 *
 * FIDELITY CONTRACT (the whole reason this package exists):
 *  - Request bytes are forwarded as received. The ONLY byte the tap may change is
 *    the Host header value (real providers reject foreign Host), spliced at the
 *    byte level; both the as-received and forwarded heads are recorded so the
 *    splice is auditable. rewriteHost:false disables even that (rig conformance).
 *  - Response bytes are forwarded EXACTLY as received from upstream — including
 *    chunk framing and content-encoding. gzip/br bodies are stored compressed as
 *    received (spec §8: decompressing a COPY for inspection is a separate,
 *    lossless step; re-compressing breaks byte identity).
 *  - Bodies are NEVER parsed on the forwarding path. The only parsing is framing
 *    OBSERVATION (ResponseFramer) to know when a response ended, and metadata
 *    extraction (request line, status line) for the index.
 *  - Truncation is propagated as truncation: if upstream dies mid-response, the
 *    client sees the same partial bytes and no fabricated terminator; if the
 *    client aborts, upstream is aborted too. Captures are then marked
 *    `incomplete:*` — never `complete` (a fixture may not claim a terminal event
 *    it did not observe).
 *  - Fail-open adjacent (I1): the tap adds no timeouts of its own on responses —
 *    long silences are legitimate mid-stream (tool-input streaming pauses). The
 *    only timeout is the upstream CONNECT, after which the client gets an
 *    explicit, distinguishable 502 (never a silent hang, never fabricated 200s).
 *
 * V0a simplifications (documented, deliberate):
 *  - A fresh upstream connection per request (no pooling): costs one handshake
 *    per request; keeps framing/reuse state out of the capture path.
 *  - HTTP pipelining (next request before current response completes) is treated
 *    as an anomaly and kills the connection with a recorded error — undici does
 *    not pipeline by default, and guessing here would corrupt captures.
 *  - Chunked REQUEST bodies are refused with a loud 501 + recorded error rather
 *    than silently mis-captured (DSH sends content-length on chat completions).
 */

import net from 'node:net'
import { performance } from 'node:perf_hooks'
import tls from 'node:tls'
import { findHead, headValue, ResponseFramer, spliceHostHeader, type ParsedHead } from './http-lite.js'
import { CaptureRecorder, type RecordingCapture } from './recorder.js'
import type { CaptureStatus, TapConfig, TapHandle } from './types.js'

const DEFAULT_OUT_DIR = './observer-data/captures'
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

function noop(): void {
  /* socket errors are observations, not crashes */
}

const TAP_DEBUG = process.env['OBSERVER_TAP_DEBUG'] === '1'
function dbg(...args: unknown[]): void {
  if (TAP_DEBUG) console.error('[tap]', ...args)
}

interface TapDeps {
  recorder: CaptureRecorder
  upstreamHost: string
  upstreamPort: number
  upstreamTls: boolean
  upstreamOrigin: string
  rewriteHost: boolean
  tlsRejectUnauthorized: boolean
  connectTimeoutMs: number
  onCaptureId: (id: string) => void
  trackUpstream: (s: net.Socket | tls.TLSSocket, add: boolean) => void
  trackClient: (s: net.Socket, add: boolean) => void
}

export async function startTap(cfg: TapConfig): Promise<TapHandle> {
  const upstream = new URL(cfg.upstreamOrigin)
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    throw new Error(`unsupported upstream protocol: ${upstream.protocol} (expected http: or https:)`)
  }
  const upstreamTls = upstream.protocol === 'https:'
  const recorder = new CaptureRecorder(cfg.outDir ?? DEFAULT_OUT_DIR)
  const captureIds: string[] = []
  const clientSockets = new Set<net.Socket>()
  const upstreamSockets = new Set<net.Socket | tls.TLSSocket>()

  const deps: TapDeps = {
    recorder,
    upstreamHost: upstream.hostname,
    upstreamPort: Number(upstream.port || (upstreamTls ? 443 : 80)),
    upstreamTls,
    upstreamOrigin: `${upstream.protocol}//${upstream.hostname}:${upstream.port || (upstreamTls ? 443 : 80)}`,
    rewriteHost: cfg.rewriteHost ?? true,
    tlsRejectUnauthorized: cfg.tlsRejectUnauthorized ?? true,
    connectTimeoutMs: cfg.upstreamConnectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    onCaptureId: (id) => captureIds.push(id),
    trackUpstream: (s, add) => {
      if (add) upstreamSockets.add(s)
      else upstreamSockets.delete(s)
    },
    trackClient: (s, add) => {
      if (add) clientSockets.add(s)
      else clientSockets.delete(s)
    },
  }

  const server = net.createServer((client) => {
    clientSockets.add(client)
    new TapConnection(client, deps) // eslint-disable-line no-new -- self-wiring via events
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.listenPort ?? 0, cfg.listenHost ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('unexpected listen address')

  return {
    port: address.port,
    origin: `http://${cfg.listenHost ?? '127.0.0.1'}:${address.port}`,
    outDir: recorder.outDir,
    captureIds: () => [...captureIds],
    stop: async () => {
      for (const s of clientSockets) s.destroy()
      for (const s of upstreamSockets) s.destroy()
      clientSockets.clear()
      upstreamSockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// ---------------------------------------------------------------------------
// Per-client-connection session: supports sequential keep-alive requests.
// ---------------------------------------------------------------------------

class TapConnection {
  #client: net.Socket
  #deps: TapDeps
  #pending: Buffer = Buffer.alloc(0)
  #exchange: Exchange | null = null
  #clientClosed = false

  constructor(client: net.Socket, deps: TapDeps) {
    this.#client = client
    this.#deps = deps
    client.setNoDelay(true)
    client.on('error', noop)
    client.on('data', (d: Buffer) => {
      if (this.#clientClosed) return
      this.#pending = this.#pending.length === 0 ? d : Buffer.concat([this.#pending, d])
      this.#pump()
    })
    client.on('close', () => {
      dbg('client socket closed')
      this.#clientClosed = true
      this.#deps.trackClient(this.#client, false)
      this.#exchange?.onClientGone()
    })
    client.on('end', () => dbg('client socket end (FIN from client)'))
  }

  #pump(): void {
    dbg(`pump: pending=${this.#pending.length} exchange=${this.#exchange ? 'active' : 'none'} clientClosed=${this.#clientClosed}`)
    if (this.#exchange) {
      // Active request: route bytes to it. Anything the exchange reports back
      // belongs to the NEXT request (keep-alive race: the previous exchange's
      // write-behind finalize has not retired it yet) — requeue and let the
      // onDone pump pick it up. Order is preserved: takePending() emptied the
      // buffer, so the requeued bytes are strictly older than future events.
      const bytes = this.#takePending()
      if (bytes.length > 0) {
        const overflow = this.#exchange.feedClient(bytes)
        if (overflow.length > 0) {
          dbg(`requeueing ${overflow.length} byte(s) for the next exchange`)
          this.#pending = this.#pending.length === 0 ? overflow : Buffer.concat([overflow, this.#pending])
        }
      }
      return
    }
    if (this.#clientClosed) return
    const parsed = findHead(this.#pending)
    if (!parsed) return // wait for the rest of the head
    const head = Buffer.from(this.#pending.subarray(0, parsed.length))
    this.#pending = this.#pending.subarray(parsed.length)
    const rest = this.#takePending()
    const ex = new Exchange(this.#client, this.#deps, head, parsed, () => {
      this.#exchange = null
      this.#pump() // keep-alive: another request may already be buffered
    })
    this.#exchange = ex
    void ex.start(rest)
  }

  #takePending(): Buffer {
    const p = this.#pending
    this.#pending = Buffer.alloc(0)
    return p
  }
}

// ---------------------------------------------------------------------------
// One request/response exchange.
// ---------------------------------------------------------------------------

class Exchange {
  #client: net.Socket
  #deps: TapDeps
  #capture: RecordingCapture
  #framer = new ResponseFramer()
  #headBytes: Buffer
  #parsed: ParsedHead
  #onDone: () => void
  #up: net.Socket | tls.TLSSocket | undefined
  #t0 = performance.now()
  #reqRemaining = 0
  #reqDone: boolean
  #resDone = false
  #finalized = false
  #clientKeepAlive = true
  #upstreamGone = false
  #drainHooked = false

  constructor(client: net.Socket, deps: TapDeps, headBytes: Buffer, parsed: ParsedHead, onDone: () => void) {
    this.#client = client
    this.#deps = deps
    this.#headBytes = headBytes
    this.#parsed = parsed
    this.#onDone = onDone
    this.#capture = deps.recorder.begin()
    deps.onCaptureId(this.#capture.id)
    dbg(`exchange ${this.#capture.id} created for ${parsed.firstLine}`)
    this.#reqDone = false
  }

  async start(initialBodyBytes: Buffer): Promise<void> {
    const cap = this.#capture
    cap.recordRequestHead(this.#headBytes)
    const parts = this.#parsed.firstLine.split(' ')
    cap.setRequestLine(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '')

    // Chunked request bodies: refuse loudly rather than silently mis-capture.
    const te = headValue(this.#parsed, this.#headBytes, 'transfer-encoding')
    if (te !== undefined && te.toLowerCase().includes('chunked')) {
      this.#respondSynthetic(501, 'Not Implemented', 'capture tap V0a: chunked request bodies are not supported')
      await cap.finalize('refused', 'chunked transfer-encoding on request body is not supported by V0a')
      this.#finishExchange()
      return
    }
    const cl = headValue(this.#parsed, this.#headBytes, 'content-length')
    this.#reqRemaining = cl !== undefined ? Number(cl) : 0
    if (!Number.isInteger(this.#reqRemaining) || this.#reqRemaining < 0) {
      this.#respondSynthetic(400, 'Bad Request', 'capture tap: invalid content-length')
      await cap.finalize('refused', `invalid content-length header: ${cl ?? '(absent)'}`)
      this.#finishExchange()
      return
    }
    const connHeader = headValue(this.#parsed, this.#headBytes, 'connection')
    this.#clientKeepAlive = connHeader === undefined ? true : !connHeader.toLowerCase().includes('close')

    // Host splice (the tap's single allowed mutation; recorded both ways).
    let fwdHead = this.#headBytes
    if (this.#deps.rewriteHost) {
      const hostValue = this.#hostForUpstream()
      const spliced = spliceHostHeader(this.#headBytes, hostValue)
      fwdHead = spliced.head
      cap.setHostRewritten(spliced.changed)
      if (spliced.changed) cap.recordForwardedHead(fwdHead)
    }

    // Connect upstream with the client paused: no in-memory body queueing.
    this.#client.pause()
    cap.setUpstream(this.#deps.upstreamOrigin, this.#deps.upstreamTls)
    let up: net.Socket | tls.TLSSocket
    try {
      up = await this.#connectUpstream()
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      this.#client.resume()
      this.#respondSynthetic(502, 'Bad Gateway', `capture tap: upstream connect failed: ${msg}`)
      await cap.finalize('incomplete:upstream-connect-failed', msg)
      this.#finishExchange()
      return
    }
    this.#up = up
    this.#deps.trackUpstream(up, true)
    up.setNoDelay(true)
    up.on('error', (err: Error) => {
      if (!this.#resDone) {
        void this.#finalize('incomplete:upstream-aborted', `${err.name}: ${err.message}`).then(() => {
          this.#client.destroySoon()
          this.#finishExchange()
        })
      }
    })
    up.on('data', (d: Buffer) => this.#onUpstreamData(d))
    up.on('close', () => {
      this.#deps.trackUpstream(up, false)
      this.#upstreamGone = true
      if (this.#resDone || this.#finalized) return
      // FIN from upstream: close-delimited bodies complete here; anything else truncated.
      this.#framer.markSocketEnd()
      if (this.#framer.complete) {
        void this.#completeResponse()
      } else {
        void this.#finalize('incomplete:upstream-aborted', 'upstream closed before response framing completed').then(() => {
          // Propagate truncation faithfully: flush what was forwarded, then kill —
          // never emit a chunked terminator the upstream did not send.
          this.#client.destroySoon()
          this.#finishExchange()
        })
      }
    })

    up.write(fwdHead)
    this.#client.resume()
    if (this.#reqRemaining === 0) this.#reqDone = true
    if (initialBodyBytes.length > 0) this.feedClient(initialBodyBytes)
  }

  #hostForUpstream(): string {
    const { upstreamHost, upstreamPort, upstreamTls } = this.#deps
    const defaultPort = upstreamTls ? 443 : 80
    return upstreamPort === defaultPort ? upstreamHost : `${upstreamHost}:${upstreamPort}`
  }

  #connectUpstream(): Promise<net.Socket | tls.TLSSocket> {
    const { upstreamHost, upstreamPort, upstreamTls, tlsRejectUnauthorized, connectTimeoutMs } = this.#deps
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error(`connect timed out after ${connectTimeoutMs}ms`))
        }
      }, connectTimeoutMs)
      const done = (err: Error | null, sock?: net.Socket | tls.TLSSocket): void => {
        if (settled) {
          if (err && sock) sock.destroy()
          return
        }
        settled = true
        clearTimeout(timer)
        if (err || !sock) reject(err ?? new Error('connect failed'))
        else resolve(sock)
      }
      if (upstreamTls) {
        const sock = tls.connect(
          { host: upstreamHost, port: upstreamPort, servername: upstreamHost, rejectUnauthorized: tlsRejectUnauthorized },
          () => done(null, sock),
        )
        sock.once('error', (e) => done(e))
      } else {
        const sock = net.connect({ host: upstreamHost, port: upstreamPort }, () => done(null, sock))
        sock.once('error', (e) => done(e))
      }
    })
  }

  /**
   * Client-side bytes for the active exchange. Returns any bytes that belong to
   * the NEXT request (only possible once this exchange's response is complete —
   * the write-behind finalize may not have retired the exchange yet); the
   * connection requeues them.
   */
  feedClient(d: Buffer): Buffer {
    if (this.#reqDone) {
      if (this.#resDone) {
        // Response already complete: these bytes are the next keep-alive request.
        return d
      }
      // True pipelining (next request sent before the current response completed):
      // an anomaly we refuse to guess about.
      void this.#finalize('refused', 'client pipelined a request before the response completed (unsupported)').then(() => {
        this.#up?.destroy()
        this.#client.destroy()
        this.#finishExchange()
      })
      return Buffer.alloc(0)
    }
    const tMs = performance.now() - this.#t0
    const take = Math.min(this.#reqRemaining, d.length)
    if (take > 0) {
      const piece = d.subarray(0, take)
      this.#capture.recordRequestBody(Buffer.from(piece), tMs)
      this.#up?.write(piece)
      this.#reqRemaining -= take
      if (this.#reqRemaining === 0) this.#reqDone = true
    }
    if (take < d.length) {
      // Excess after a complete request body: recurse to classify (next-request
      // bytes vs pipelining anomaly) exactly as above.
      return this.feedClient(d.subarray(take))
    }
    return Buffer.alloc(0)
  }

  #onUpstreamData(d: Buffer): void {
    if (this.#resDone) return // post-completion bytes: ignore (framing said done)
    const tMs = performance.now() - this.#t0
    this.#capture.recordResponseWire(Buffer.from(d), tMs)
    this.#framer.feed(d)
    const sl = this.#framer.statusLine
    if (sl !== undefined) this.#capture.setResponseStatusLine(sl)
    const ok = this.#client.write(d)
    if (!ok && !this.#drainHooked && this.#up) {
      this.#drainHooked = true
      const up = this.#up
      up.pause()
      this.#client.once('drain', () => {
        this.#drainHooked = false
        up.resume()
      })
    }
    if (this.#framer.complete) void this.#completeResponse()
  }

  async #completeResponse(): Promise<void> {
    if (this.#resDone) return
    this.#resDone = true
    dbg(`response complete (mode=${this.#framer.mode}, keepAlive=${this.#clientKeepAlive})`)
    this.#up?.destroy() // no upstream pooling in V0a (documented simplification)
    await this.#finalize('complete')
    const closeDelimited = this.#framer.mode === 'close'
    if (!this.#clientKeepAlive || closeDelimited) {
      dbg('ending client connection (keep-alive not requested or close-delimited response)')
      this.#client.end()
      this.#finishExchange()
    } else {
      dbg('keeping client connection open for next request')
      this.#finishExchange() // connection stays open for the next request
    }
  }

  onClientGone(): void {
    if (this.#finalized) return
    this.#up?.destroy()
    void this.#finalize('incomplete:client-aborted').then(() => this.#finishExchange())
  }

  async #finalize(status: CaptureStatus, error?: string): Promise<void> {
    if (this.#finalized) return
    this.#finalized = true
    try {
      await this.#capture.finalize(status, error)
    } catch {
      // A recorder failure must never break forwarding (I1). The capture is lost;
      // the absence of meta.json marks it suspect. Nothing to fabricate.
    }
  }

  #finishExchange(): void {
    this.#onDone()
  }

  /** Synthesized error responses are NOT recorded as response wire (they are not
   * upstream truth); meta.status + meta.error explain them. */
  #respondSynthetic(code: number, reason: string, message: string): void {
    const body = Buffer.from(`${message}\n`, 'utf8')
    const head = Buffer.from(
      `HTTP/1.1 ${code} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\nx-observer-tap: capture-v0a\r\n\r\n`,
      'utf8',
    )
    if (!this.#client.destroyed) {
      this.#client.write(Buffer.concat([head, body]))
      this.#client.end()
    }
  }
}
