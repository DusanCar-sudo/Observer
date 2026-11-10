/**
 * Capture-store types for the V0a tap.
 *
 * Ground rule (spec §8, protocol-fidelity §4A.1): the artifacts below are RAW
 * BYTES as observed on the wire. `reasoning_content` is absent from OpenAI's own
 * ChoiceDelta schema — a tap that parsed and re-serialised would silently drop
 * 100% of reasoning on target one, and every fixture captured through it would be
 * wrong in a way no test could catch. Parsing happens only in derived, lossless
 * inspection steps, never on the forwarding path and never as a storage format.
 */

/**
 * A header as an ordered `[name, value]` pair, both latin1-decoded from the exact
 * bytes on the wire. A list rather than a map because order is part of what was
 * observed: folding duplicates or re-sorting would make the recorded head
 * unreproducible from the record.
 */
export type HeaderPairs = [string, string][]

/** One body/wire arrival event, for timeline reconstruction of fixtures. */
export interface CaptureArrival {
  /** ms since the capture's t0 (request head complete, client side). */
  tMs: number
  bytes: number
  cumBytes: number
}

export type CaptureStatus =
  | 'complete' // full request forwarded, full response delivered, framing terminated
  | 'incomplete:client-aborted' // client vanished mid-request or mid-response
  | 'incomplete:upstream-aborted' // upstream died mid-response (or after headers, truncated)
  | 'incomplete:upstream-connect-failed' // could not reach upstream at all
  | 'refused' // tap rejected the request itself (unsupported shape / anomaly); meta.error says why

/** meta.json — written LAST; its presence with status marks the capture final. */
export interface CaptureMeta {
  captureId: string
  /** ISO-8601 UTC start. */
  startedAt: string
  status: CaptureStatus
  upstream: {
    /** Scheme+host+port the tap dialed (path/query live in the request head). */
    origin: string
    tls: boolean
  }
  request: {
    method: string
    target: string
    httpVersion: string
    /** Bytes as received from the client (pre-any-rewrite). */
    headBytes: number
    bodyBytes: number
    bodySha256: string
    /** True when the tap spliced the Host header for forwarding (recorded separately). */
    hostRewritten: boolean
    /** Body arrivals as received. */
    arrivals: CaptureArrival[]
  }
  response: {
    /** Raw wire bytes recorded (status line + headers + framing + body, as received from upstream). */
    wireBytes: number
    wireSha256: string
    statusLine?: string | undefined
    /** Wire-byte arrivals as received from upstream (fixture timing reconstruction source). */
    arrivals: CaptureArrival[]
    /** Set when the response framing never terminated. */
    truncated: boolean
  }
  /** What forwarding errors happened, if any (never fabricates bytes). */
  error?: string | undefined
  /**
   * false in the raw store, ALWAYS (I2: raw truth is append-only and never
   * redacted in place). true only in derived export copies produced by
   * redactCapture(), whose hashes therefore differ from raw by design.
   */
  redacted: boolean
}

/** One line of captures.jsonl — the append-only index (V2 formalises the store). */
export interface CaptureIndexEntry {
  captureId: string
  startedAt: string
  status: CaptureStatus
  method: string
  target: string
  responseStatusLine?: string | undefined
  requestBodyBytes: number
  responseWireBytes: number
  requestBodySha256: string
  responseWireSha256: string
}

export interface TapConfig {
  /** Bind address for the DSH-facing side. Default 127.0.0.1. */
  listenHost?: string
  /** 0 = ephemeral. */
  listenPort?: number
  /** Real provider origin, e.g. https://token-plan.ap-southeast-1.maas.aliyuncs.com */
  upstreamOrigin: string
  /** Capture store output directory. Default ./observer-data/captures (gitignored). */
  outDir?: string
  /**
   * Rewrite the Host header (byte splice, nothing else touched) to the upstream
   * host when forwarding. REQUIRED for real providers (they reject foreign Host);
   * disable in rig conformance runs where the mock upstream accepts any Host, so
   * the tap can be proven byte-identical end to end. Both the as-received and the
   * forwarded head are recorded either way.
   */
  rewriteHost?: boolean
  /** Test-only: accept self-signed upstream certs (local TLS tests). */
  tlsRejectUnauthorized?: boolean
  /** Per-request upstream connect timeout, ms. Default 10_000. */
  upstreamConnectTimeoutMs?: number
}

export interface TapHandle {
  port: number
  origin: string
  outDir: string
  /** Capture ids finalized so far, in order. */
  captureIds(): string[]
  stop(): Promise<void>
}
