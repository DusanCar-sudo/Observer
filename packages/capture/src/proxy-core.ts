/**
 * Proxy core: the byte-faithful request/response pipeline shared by the V0a tap
 * and the V1 gateway.
 *
 * WHY THIS IS SHARED (spec §1): "Byte fidelity is the slice's entire claim, and it
 * is untestable if it lives inside an HTTP server." The spec's corollary is the
 * rule this file follows — "two components that both 'guarantee' append-only-hashed
 * produce a guarantee nobody tests" (said there about store/ vs ledger/, and it is
 * the same failure): a second byte-faithful proxy would be a second guarantee
 * nobody judges. So the delicate machinery — keep-alive exchange sequencing, the
 * write-behind-finalize race (spec §9.4), truncation propagation, backpressure, the
 * Host-only byte splice — exists ONCE, is judged ONCE by the rig, and both products
 * stay thin policy layers over it. `@observer/capture` owns it because capture is
 * the unit the spec isolates to be testable without a socket; the gateway adds
 * routing/refusals/stats, the tap adds nothing (it is `route: FORWARD_ALL`).
 *
 * FIDELITY CONTRACT (inherited from the tap, unchanged):
 *  - Request bytes are forwarded as received; the ONLY byte the core may change
 *    is the Host header value (byte splice, recorded both ways, disableable).
 *  - Response bytes are forwarded EXACTLY as received from upstream — chunk
 *    framing and content-encoding included. Nothing is decompressed, parsed, or
 *    re-serialised on the forwarding path.
 *  - Truncation is propagated as truncation; no terminator is ever fabricated.
 *  - Capture is write-behind and wrapped so recorder failures can NEVER enter
 *    the request path (I1/A6): failures degrade to counted events.
 *  - No response-side timeouts: long silences are legitimate mid-stream. The
 *    only timeout is the upstream CONNECT, which yields an explicit,
 *    distinguishable synthetic error — never a silent hang, never a 500 that
 *    could be mistaken for the provider's.
 *
 * POLICY SEAM (what makes this a core and not a tap):
 *  - route(info) is consulted once per request head: 'forward' or 'refuse' with
 *    a synthetic response. Refusals still RECORD the request (head, and body as
 *    it drains) and are counted via events — a refusal is Observer behaviour and
 *    subject to I2 like everything else.
 *  - onEvent(ev) receives lifecycle events for stats. Event handlers are wrapped:
 *    a throwing stats hook cannot break traffic.
 *  - recorder is injectable (RecorderLike); tests poison it to prove fail-open.
 *
 * Deliberate simplifications (documented, carried from V0a):
 *  - Fresh upstream connection per request (no pooling). Rig-measured latency
 *    impact is sub-millisecond on loopback; production pooling against a real
 *    TLS upstream is tracked for the V4e transport work and will be measured
 *    (task-17 live run) before being decided.
 *  - HTTP pipelining (next request before the current response completes) is
 *    refused with a recorded reason; undici does not pipeline by default.
 *    KEEP-ALIVE bytes arriving during write-behind finalization are NOT
 *    pipelining and are requeued for the next exchange (spec §9.4 named test).
 *  - Chunked REQUEST bodies are refused structurally (no request-side chunk
 *    decoder exists; DSH sends content-length on chat completions).
 */

import net from 'node:net'
import { performance } from 'node:perf_hooks'
import tls from 'node:tls'
import { findHead, headValue, isHopByHopName, ResponseFramer, spliceHostHeader, stripHeaderLines, type ParsedHead } from './http-lite.js'
import { CaptureRecorder, NULL_CAPTURE, type RecorderLike, type RecordingCapture } from './recorder.js'
import type { CaptureMeta, CaptureStatus, HeaderPairs } from './types.js'

export const DEFAULT_OUT_DIR = './observer-data/captures'
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

const PROXY_DEBUG = process.env['OBSERVER_PROXY_DEBUG'] === '1' || process.env['OBSERVER_TAP_DEBUG'] === '1'
function dbg(label: string, ...args: unknown[]): void {
  if (PROXY_DEBUG) console.error(`[${label}]`, ...args)
}

// ---------------------------------------------------------------------------
// Policy surface
// ---------------------------------------------------------------------------

export interface ProxyRequestInfo {
  method: string
  target: string
  httpVersion: string
  headerPairs: HeaderPairs
  headBytes: Buffer
}

export interface SyntheticResponse {
  status: number
  reason: string
  /** utf-8 text body. Static strings only — this layer never serialises data. */
  body: string
  contentType?: string
  extraHeaders?: HeaderPairs
}

export type RouteDecision =
  | { kind: 'forward' }
  | { kind: 'refuse'; reason: string; response: SyntheticResponse }

export type ProxyEvent =
  | { kind: 'exchange-start'; captureId: string; method: string; target: string }
  | { kind: 'refused'; captureId: string; reason: string; method: string; target: string }
  | { kind: 'forwarded'; captureId: string }
  | { kind: 'response-complete'; captureId: string; statusLine: string | undefined }
  | { kind: 'response-truncated'; captureId: string; status: CaptureStatus; error: string | undefined }
  | { kind: 'client-aborted'; captureId: string }
  | { kind: 'upstream-connect-failed'; captureId: string; error: string }
  | { kind: 'capture-error'; captureId: string | undefined; phase: string; error: string }

export interface ProxyCoreConfig {
  listenHost?: string
  listenPort?: number
  upstreamOrigin: string
  /** Splice Host to the upstream authority. Default true. Rig conformance runs use false. */
  rewriteHost?: boolean
  /**
   * Strip hop-by-hop header lines from the forwarded request head (V1/A4).
   * Byte-level excision; all other head bytes preserved verbatim. Default FALSE:
   * the V0a tap's accepted behaviour forwards the head untouched (its whole
   * contract was "the Host value is the ONLY changed byte"), while the gateway
   * opts in per A4.
   */
  stripRequestHopByHop?: boolean
  tlsRejectUnauthorized?: boolean
  upstreamConnectTimeoutMs?: number
  /** Injectable recorder (tests poison this to prove A6 fail-open). */
  recorder?: RecorderLike
  /** Used when no recorder is injected. Default ./observer-data/captures. */
  outDir?: string
  /** Policy hook, consulted per request head. Default: forward everything. */
  route?: (info: ProxyRequestInfo) => RouteDecision
  /** Stats hook. Exceptions are swallowed — a stats bug must never break traffic. */
  onEvent?: (ev: ProxyEvent) => void
  /** Identification header on synthetic responses (default x-observer-tap). */
  syntheticMarkerHeader?: [string, string]
  label?: string
}

export interface ProxyCoreHandle {
  port: number
  origin: string
  /** Resolved capture dir when the built-in recorder is used. */
  outDir?: string | undefined
  captureIds(): string[]
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// Safe capture: every recorder interaction goes through this guard (I1/A6).
// ---------------------------------------------------------------------------

class SafeCapture {
  #inner: RecordingCapture | null
  #onError: (phase: string, err: unknown) => void
  #id: string

  private constructor(inner: RecordingCapture | null, id: string, onError: (phase: string, err: unknown) => void) {
    this.#inner = inner
    this.#id = id
    this.#onError = onError
  }

  static begin(recorder: RecorderLike | undefined, onError: (phase: string, err: unknown) => void): SafeCapture {
    if (!recorder) return new SafeCapture(null, 'cap-none', onError)
    try {
      const inner = recorder.begin()
      return new SafeCapture(inner, inner.id, onError)
    } catch (err) {
      onError('begin', err)
      return new SafeCapture(null, 'cap-none', onError)
    }
  }

  get id(): string {
    return this.#id
  }

  #call(phase: string, fn: (c: RecordingCapture) => void): void {
    if (!this.#inner) return
    try {
      fn(this.#inner)
    } catch (err) {
      this.#onError(phase, err)
      this.#inner = null // a recorder that threw is not trusted again for this capture
    }
  }

  recordRequestHead(b: Buffer): void {
    this.#call('recordRequestHead', (c) => c.recordRequestHead(b))
  }
  recordForwardedHead(b: Buffer): void {
    this.#call('recordForwardedHead', (c) => c.recordForwardedHead(b))
  }
  recordRequestBody(b: Buffer, t: number): void {
    this.#call('recordRequestBody', (c) => c.recordRequestBody(b, t))
  }
  recordResponseWire(b: Buffer, t: number): void {
    this.#call('recordResponseWire', (c) => c.recordResponseWire(b, t))
  }
  setRequestLine(m: string, t: string, v: string): void {
    this.#call('setRequestLine', (c) => c.setRequestLine(m, t, v))
  }
  setResponseStatusLine(l: string): void {
    this.#call('setResponseStatusLine', (c) => c.setResponseStatusLine(l))
  }
  setHostRewritten(v: boolean): void {
    this.#call('setHostRewritten', (c) => c.setHostRewritten(v))
  }
  setUpstream(o: string, t: boolean): void {
    this.#call('setUpstream', (c) => c.setUpstream(o, t))
  }
  async finalize(status: CaptureStatus, error?: string): Promise<CaptureMeta | undefined> {
    if (!this.#inner) return undefined
    try {
      return await this.#inner.finalize(status, error)
    } catch (err) {
      this.#onError('finalize', err)
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

interface CoreDeps {
  label: string
  recorder: RecorderLike | undefined
  upstreamHost: string
  upstreamPort: number
  upstreamTls: boolean
  upstreamOrigin: string
  rewriteHost: boolean
  stripRequestHopByHop: boolean
  tlsRejectUnauthorized: boolean
  connectTimeoutMs: number
  route: (info: ProxyRequestInfo) => RouteDecision
  emit: (ev: ProxyEvent) => void
  onCaptureId: (id: string) => void
  trackUpstream: (s: net.Socket | tls.TLSSocket, add: boolean) => void
  trackClient: (s: net.Socket, add: boolean) => void
  syntheticMarkerHeader: [string, string]
}

export async function startProxy(cfg: ProxyCoreConfig): Promise<ProxyCoreHandle> {
  const upstream = new URL(cfg.upstreamOrigin)
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    throw new Error(`unsupported upstream protocol: ${upstream.protocol} (expected http: or https:)`)
  }
  const upstreamTls = upstream.protocol === 'https:'
  const upstreamPort = Number(upstream.port || (upstreamTls ? 443 : 80))
  const label = cfg.label ?? 'proxy'

  let recorder: RecorderLike | undefined = cfg.recorder
  let resolvedOutDir: string | undefined
  if (!recorder) {
    const cr = new CaptureRecorder(cfg.outDir ?? DEFAULT_OUT_DIR)
    cr.onWriteError = (captureId, err) => emit({ kind: 'capture-error', captureId, phase: 'stream-write', error: err.message })
    recorder = cr
    resolvedOutDir = cr.outDir
  }

  const captureIds: string[] = []
  const clientSockets = new Set<net.Socket>()
  const upstreamSockets = new Set<net.Socket | tls.TLSSocket>()

  function emit(ev: ProxyEvent): void {
    try {
      cfg.onEvent?.(ev)
    } catch {
      // A throwing stats hook must never break traffic (I1). The loss is silent
      // by necessity; event hooks are required to be trivial.
    }
  }

  const deps: CoreDeps = {
    label,
    recorder,
    upstreamHost: upstream.hostname,
    upstreamPort,
    upstreamTls,
    upstreamOrigin: `${upstream.protocol}//${upstream.hostname}:${upstreamPort}`,
    rewriteHost: cfg.rewriteHost ?? true,
    stripRequestHopByHop: cfg.stripRequestHopByHop ?? false,
    tlsRejectUnauthorized: cfg.tlsRejectUnauthorized ?? true,
    connectTimeoutMs: cfg.upstreamConnectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    route: cfg.route ?? (() => ({ kind: 'forward' as const })),
    emit,
    onCaptureId: (id) => captureIds.push(id),
    trackUpstream: (s, add) => {
      if (add) upstreamSockets.add(s)
      else upstreamSockets.delete(s)
    },
    trackClient: (s, add) => {
      if (add) clientSockets.add(s)
      else clientSockets.delete(s)
    },
    // The marker names the LAYER that produced the synthetic response, not a version:
    // a shared core must not let the tap's name leak onto a gateway refusal.
    syntheticMarkerHeader: cfg.syntheticMarkerHeader ?? ['x-observer-tap', label],
  }

  const server = net.createServer((client) => {
    clientSockets.add(client)
    new ProxyConnection(client, deps) // eslint-disable-line no-new -- self-wiring via events
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
    ...(resolvedOutDir !== undefined ? { outDir: resolvedOutDir } : {}),
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
// Per-client-connection session: sequential keep-alive requests.
// ---------------------------------------------------------------------------

class ProxyConnection {
  #client: net.Socket
  #deps: CoreDeps
  #pending: Buffer = Buffer.alloc(0)
  #exchange: Exchange | null = null
  #clientClosed = false

  constructor(client: net.Socket, deps: CoreDeps) {
    this.#client = client
    this.#deps = deps
    client.setNoDelay(true)
    client.on('error', () => undefined)
    client.on('data', (d: Buffer) => {
      if (this.#clientClosed) return
      this.#pending = this.#pending.length === 0 ? d : Buffer.concat([this.#pending, d])
      this.#pump()
    })
    client.on('close', () => {
      dbg(deps.label, 'client socket closed')
      this.#clientClosed = true
      this.#deps.trackClient(this.#client, false)
      this.#exchange?.onClientGone()
    })
    client.on('end', () => dbg(deps.label, 'client socket end (FIN from client)'))
  }

  #pump(): void {
    dbg(this.#deps.label, `pump: pending=${this.#pending.length} exchange=${this.#exchange ? 'active' : 'none'} clientClosed=${this.#clientClosed}`)
    if (this.#exchange) {
      // Active request: route bytes to it. Anything the exchange hands back
      // belongs to the NEXT request (keep-alive race: the previous exchange's
      // write-behind finalize has not retired it yet) — requeue and let the
      // onDone pump pick it up. Order is preserved: takePending() emptied the
      // buffer, so requeued bytes are strictly older than future events.
      // THIS IS THE §9.4 NAMED-TEST SHAPE — do not "simplify" it away.
      const bytes = this.#takePending()
      if (bytes.length > 0) {
        const overflow = this.#exchange.feedClient(bytes)
        if (overflow.length > 0) {
          dbg(this.#deps.label, `requeueing ${overflow.length} byte(s) for the next exchange`)
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
    const ex = new Exchange(
      this.#client,
      this.#deps,
      head,
      parsed,
      () => {
        this.#exchange = null
        this.#pump() // keep-alive: another request may already be buffered
      },
      (overflow: Buffer) => {
        // Bytes belonging to the NEXT request surfaced from inside the exchange
        // (body completed mid-event): requeue at the FRONT of pending and pump.
        this.#pending = this.#pending.length === 0 ? overflow : Buffer.concat([overflow, this.#pending])
        this.#pump()
      },
    )
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
  #deps: CoreDeps
  #capture: SafeCapture
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
  #drainHooked = false
  #refused = false
  /** Why the policy refused; recorded as the capture's error on finalize. */
  #refuseReason = 'refused'
  #info: ProxyRequestInfo
  #onOverflow: (b: Buffer) => void

  constructor(
    client: net.Socket,
    deps: CoreDeps,
    headBytes: Buffer,
    parsed: ParsedHead,
    onDone: () => void,
    onOverflow: (b: Buffer) => void,
  ) {
    this.#client = client
    this.#deps = deps
    this.#headBytes = headBytes
    this.#parsed = parsed
    this.#onDone = onDone
    this.#onOverflow = onOverflow
    this.#capture = SafeCapture.begin(deps.recorder, (phase, err) => {
      deps.emit({
        kind: 'capture-error',
        captureId: this.#capture?.id,
        phase,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    deps.onCaptureId(this.#capture.id)
    const parts = parsed.firstLine.split(' ')
    this.#info = {
      method: parts[0] ?? '',
      target: parts[1] ?? '',
      httpVersion: parts[2] ?? '',
      headerPairs: parsed.headers.map((h) => [
        headBytes.subarray(h.nameStart, h.nameStart + h.name.length).toString('latin1'),
        headBytes.subarray(h.valueStart, h.lineEnd).toString('latin1'),
      ] as [string, string]),
      headBytes,
    }
    this.#reqDone = false
    dbg(deps.label, `exchange ${this.#capture.id} created for ${parsed.firstLine}`)
  }

  async start(initialBodyBytes: Buffer): Promise<void> {
    const cap = this.#capture
    cap.recordRequestHead(this.#headBytes)
    cap.setRequestLine(this.#info.method, this.#info.target, this.#info.httpVersion)
    this.#deps.emit({ kind: 'exchange-start', captureId: cap.id, method: this.#info.method, target: this.#info.target })

    // ---- policy route (gateway refusals land here; tap forwards everything) ----
    let decision: RouteDecision
    try {
      decision = this.#deps.route(this.#info)
    } catch (err) {
      // A throwing route hook is OUR bug: answer with a distinguishable Observer
      // error rather than forwarding traffic we may have been told to refuse.
      decision = {
        kind: 'refuse',
        reason: `route hook threw: ${err instanceof Error ? err.message : String(err)}`,
        response: { status: 500, reason: 'Internal Server Error', body: `observer ${this.#deps.label}: internal route error\n` },
      }
    }

    const cl = headValue(this.#parsed, this.#headBytes, 'content-length')
    const clNum = cl !== undefined ? Number(cl) : 0
    const clValid = Number.isInteger(clNum) && clNum >= 0
    const connHeader = headValue(this.#parsed, this.#headBytes, 'connection')
    this.#clientKeepAlive = connHeader === undefined ? true : !connHeader.toLowerCase().includes('close')
    const te = headValue(this.#parsed, this.#headBytes, 'transfer-encoding')
    const chunkedRequest = te !== undefined && te.toLowerCase().includes('chunked')

    if (decision.kind === 'refuse') {
      await this.#refuse(decision, clValid ? clNum : undefined, chunkedRequest, initialBodyBytes)
      return
    }

    // ---- structural checks on the forward path ----
    if (chunkedRequest) {
      this.#respondSynthetic(501, 'Not Implemented', `observer ${this.#deps.label}: chunked request bodies are not supported`)
      this.#deps.emit({ kind: 'refused', captureId: cap.id, reason: 'chunked-request-body', method: this.#info.method, target: this.#info.target })
      await cap.finalize('refused', 'chunked transfer-encoding on request body is not supported')
      this.#client.end()
      this.#finishExchange()
      return
    }
    if (!clValid) {
      this.#respondSynthetic(400, 'Bad Request', `observer ${this.#deps.label}: invalid content-length`)
      this.#deps.emit({ kind: 'refused', captureId: cap.id, reason: 'invalid-content-length', method: this.#info.method, target: this.#info.target })
      await cap.finalize('refused', `invalid content-length header: ${cl ?? '(absent)'}`)
      this.#client.end()
      this.#finishExchange()
      return
    }
    this.#reqRemaining = clNum

    // Forwarded-head construction: the ONLY bytes the core may change, in order:
    // (1) hop-by-hop excision when the policy layer asks for it (V1/A4 — the tap
    //     does not; its accepted contract forwards the head untouched), then
    // (2) the Host value splice (providers reject foreign Host values).
    // Both are byte-level line surgery — never re-serialisation — and any change
    // is recorded so the as-received and forwarded heads can both be audited.
    let fwdHead = this.#headBytes
    if (this.#deps.stripRequestHopByHop) {
      fwdHead = stripHeaderLines(fwdHead, isHopByHopName).head
    }
    if (this.#deps.rewriteHost) {
      const spliced = spliceHostHeader(fwdHead, this.#hostForUpstream())
      fwdHead = spliced.head
      cap.setHostRewritten(spliced.changed)
    }
    if (!fwdHead.equals(this.#headBytes)) cap.recordForwardedHead(fwdHead)

    // Connect upstream with the client paused: no in-memory body queueing.
    this.#client.pause()
    cap.setUpstream(this.#deps.upstreamOrigin, this.#deps.upstreamTls)
    let up: net.Socket | tls.TLSSocket
    try {
      up = await this.#connectUpstream()
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      this.#client.resume()
      this.#respondSynthetic(502, 'Bad Gateway', `observer ${this.#deps.label}: upstream connect failed: ${msg}`)
      this.#deps.emit({ kind: 'upstream-connect-failed', captureId: cap.id, error: msg })
      await cap.finalize('incomplete:upstream-connect-failed', msg)
      this.#client.end()
      this.#finishExchange()
      return
    }
    this.#up = up
    this.#deps.trackUpstream(up, true)
    this.#deps.emit({ kind: 'forwarded', captureId: cap.id })
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
      if (this.#resDone || this.#finalized) return
      // FIN from upstream: close-delimited bodies complete here; anything else truncated.
      this.#framer.markSocketEnd()
      if (this.#framer.complete) {
        void this.#completeResponse()
      } else {
        // Propagate truncation faithfully: flush what was forwarded, then kill —
        // never emit a chunked terminator the upstream did not send.
        this.#deps.emit({ kind: 'response-truncated', captureId: this.#capture.id, status: 'incomplete:upstream-aborted', error: 'upstream closed before framing completed' })
        void this.#finalize('incomplete:upstream-aborted', 'upstream closed before response framing completed').then(() => {
          this.#client.destroySoon()
          this.#finishExchange()
        })
      }
    })

    up.write(fwdHead)
    this.#client.resume()
    if (this.#reqRemaining === 0) this.#reqDone = true
    if (initialBodyBytes.length > 0) this.#routeBodyBytes(initialBodyBytes)
  }

  /**
   * Refusal flow: answer IMMEDIATELY (the client learns fast even mid-upload),
   * then DRAIN the declared request body before closing. Closing with unread
   * request bytes in flight risks a kernel RST eating our own response — the
   * client would see a reset instead of the 501. The drained body is still
   * recorded: a refusal is Observer behaviour and subject to I2.
   */
  async #refuse(decision: Extract<RouteDecision, { kind: 'refuse' }>, clNum: number | undefined, chunkedRequest: boolean, initialBodyBytes: Buffer): Promise<void> {
    this.#refused = true
    this.#refuseReason = decision.reason
    const cap = this.#capture
    const r = decision.response
    const body = Buffer.from(r.body, 'utf8')
    const marker = this.#deps.syntheticMarkerHeader
    let head = `HTTP/1.1 ${r.status} ${r.reason}\r\n`
    head += `content-type: ${r.contentType ?? 'text/plain; charset=utf-8'}\r\n`
    head += `content-length: ${body.length}\r\n`
    head += `connection: close\r\n`
    head += `${marker[0]}: ${marker[1]}\r\n`
    for (const [n, v] of r.extraHeaders ?? []) head += `${n}: ${v}\r\n`
    head += '\r\n'
    if (!this.#client.destroyed) this.#client.write(Buffer.concat([Buffer.from(head, 'utf8'), body]))

    cap.setUpstream(this.#deps.upstreamOrigin, this.#deps.upstreamTls)
    this.#deps.emit({ kind: 'refused', captureId: cap.id, reason: decision.reason, method: this.#info.method, target: this.#info.target })

    const canDrain = clNum !== undefined && !chunkedRequest
    if (!canDrain) {
      // Body extent unknowable (chunked or broken CL): nothing safe to drain.
      if (initialBodyBytes.length > 0) cap.recordRequestBody(Buffer.from(initialBodyBytes), performance.now() - this.#t0)
      await cap.finalize('refused', decision.reason)
      this.#client.destroySoon()
      this.#finishExchange()
      return
    }
    this.#reqRemaining = clNum
    if (this.#reqRemaining === 0) this.#reqDone = true
    if (initialBodyBytes.length > 0) this.#routeBodyBytes(initialBodyBytes)
    if (this.#reqDone) {
      await cap.finalize('refused', decision.reason)
      this.#client.end()
      this.#finishExchange()
    }
    // else: remaining body bytes drain through feedClient; completion finalizes there.
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
   * write-behind finalize may not have retired it yet); the connection requeues
   * them. THIS IS THE §9.4 SHAPE.
   */
  feedClient(d: Buffer): Buffer {
    if (this.#reqDone) {
      if (this.#resDone) {
        // Response already complete: these bytes are the next keep-alive request.
        return d
      }
      if (this.#refused) {
        // Refusal answered with connection: close — the client was told not to
        // send more; drop anything that still arrives.
        return Buffer.alloc(0)
      }
      this.#pipeliningAnomaly()
      return Buffer.alloc(0)
    }
    this.#routeBodyBytes(d)
    return Buffer.alloc(0)
  }

  /** Classify bytes that arrived beyond this request's declared body. */
  #handleExcess(excess: Buffer): void {
    if (this.#resDone) {
      this.#onOverflow(excess) // next keep-alive request, arrived in the same event
      return
    }
    if (this.#refused) return // connection: close was sent; drop
    this.#pipeliningAnomaly()
  }

  #pipeliningAnomaly(): void {
    // True pipelining (next request before the current response completed):
    // an anomaly we refuse to guess about.
    this.#deps.emit({ kind: 'refused', captureId: this.#capture.id, reason: 'pipelining', method: this.#info.method, target: this.#info.target })
    void this.#finalize('refused', 'client pipelined a request before the response completed (unsupported)').then(() => {
      this.#up?.destroy()
      this.#client.destroy()
      this.#finishExchange()
    })
  }

  #routeBodyBytes(d: Buffer): void {
    if (this.#reqDone) {
      this.#handleExcess(d)
      return
    }
    const tMs = performance.now() - this.#t0
    const take = Math.min(this.#reqRemaining, d.length)
    if (take > 0) {
      const piece = d.subarray(0, take)
      this.#capture.recordRequestBody(Buffer.from(piece), tMs)
      if (!this.#refused) this.#up?.write(piece)
      this.#reqRemaining -= take
      if (this.#reqRemaining === 0) this.#reqDone = true
    }
    if (this.#reqDone && this.#refused) {
      // Drain complete: finalize the refusal and close cleanly (no RST).
      // Record the POLICY's reason, not a generic phrase: the reason is the only
      // thing that makes a refusal auditable after the fact.
      void this.#capture.finalize('refused', this.#refuseReason).then(() => {
        this.#client.end()
        this.#finishExchange()
      })
      if (take < d.length) this.#handleExcess(d.subarray(take)) // drops (refused)
      return
    }
    if (take < d.length) this.#handleExcess(d.subarray(take))
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
    dbg(this.#deps.label, `response complete (mode=${this.#framer.mode}, keepAlive=${this.#clientKeepAlive})`)
    this.#up?.destroy() // no upstream pooling (documented simplification; V4e revisit)
    // Emit BEFORE persisting: counters must be consistent with the outcome the
    // client can already observe — the client's own half-close can complete the
    // exchange's visible effect while finalize's I/O is still in flight.
    this.#deps.emit({ kind: 'response-complete', captureId: this.#capture.id, statusLine: this.#framer.statusLine })
    await this.#finalize('complete')
    const closeDelimited = this.#framer.mode === 'close'
    if (!this.#clientKeepAlive || closeDelimited) {
      this.#client.end()
      this.#finishExchange()
    } else {
      this.#finishExchange() // connection stays open for the next request
    }
  }

  onClientGone(): void {
    if (this.#finalized) return
    this.#up?.destroy()
    this.#deps.emit({ kind: 'client-aborted', captureId: this.#capture.id })
    void this.#finalize('incomplete:client-aborted').then(() => {
      this.#finishExchange()
    })
  }

  async #finalize(status: CaptureStatus, error?: string): Promise<void> {
    if (this.#finalized) return
    this.#finalized = true
    // SafeCapture guarantees this cannot throw into the traffic path (I1/A6).
    await this.#capture.finalize(status, error)
  }

  #finishExchange(): void {
    this.#onDone()
  }

  /** Synthetic responses are NOT recorded as response wire (they are not upstream
   * truth); meta.status + meta.error + events explain them. */
  #respondSynthetic(code: number, reason: string, message: string): void {
    const body = Buffer.from(`${message}\n`, 'utf8')
    const marker = this.#deps.syntheticMarkerHeader
    const head = Buffer.from(
      `HTTP/1.1 ${code} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\n${marker[0]}: ${marker[1]}\r\n\r\n`,
      'utf8',
    )
    if (!this.#client.destroyed) {
      this.#client.write(Buffer.concat([head, body]))
    }
  }
}

// Re-export for the thin product layers.
export { NULL_CAPTURE }
