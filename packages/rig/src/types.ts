/**
 * Core types for the differential fidelity rig.
 *
 * The rig replays each fixture twice — (a) direct to a mock upstream and (b) via a
 * system-under-test (SUT) — and diffs status + headers + BODY BYTES WITH OFFSETS, plus
 * the request bytes the upstream actually saw, plus arrival timelines (inter-chunk gaps).
 *
 * Ground rule this file encodes: payloads are Buffers / raw byte refs everywhere.
 * Nothing on a comparison path is a parsed JSON document; parsing happens only inside
 * deliberately-faulty test doubles that exist to prove the rig catches them.
 */

/** Ordered (name, value) header pairs exactly as they appear on the wire. Case preserved. */
export type HeaderPairs = [name: string, value: string][]

/**
 * Where a fixture came from. `captured` is reserved for byte-exact recordings from live
 * DSH->qwen traffic via the V0a logging tap; until that exists the corpus is synthetic /
 * derived / generated, and every fixture says which. Provenance is load-bearing: a
 * `synthetic` fixture can never prove byte-fidelity against the real provider, it can
 * only prove the rig+SUT behave identically on known bytes.
 */
export type Provenance = 'synthetic' | 'derived' | 'generated' | 'captured'

export interface BigChatBodySpec {
  kind: 'big-chat-body'
  seed: number
  /** Generator guarantees output byteLength >= targetBytes. */
  targetBytes: number
}

export type GeneratorSpec = BigChatBodySpec

/**
 * A payload reference. `inline` is utf8-encoded verbatim (exact bytes, escapes included);
 * `file` is relative to the fixture directory and sha256-verified against the manifest;
 * `generate` runs a deterministic generator whose output sha256 is pinned in the manifest,
 * so a >5 MB body never has to live in git but is still verified byte-exact everywhere.
 */
export type PayloadRef =
  | { inline: string }
  | { file: string }
  | { generate: GeneratorSpec }

export interface ResponseWrite {
  payload: PayloadRef
  /**
   * Deadline-corrected delay BEFORE this write, relative to the previous write
   * (for the first write, relative to the response head flush).
   */
  delayMs: number
  /**
   * Emit this write's payload as TWO TCP writes inside a single chunked frame: the first
   * `splitAfterBytes` payload bytes, then (after SPLIT_GAP_MS) the remainder. Models a
   * server that flushes mid-frame / mid-SSE-event. Ignored when framing is 'length'.
   */
  splitAfterBytes?: number
}

export type ScriptTerminate =
  /** Normal completion: chunked terminator (if chunked) then FIN. */
  | { kind: 'end' }
  /**
   * Abrupt: socket destroyed after the given write index flushed. Delivery is FIN-like
   * (send queue is empty at destroy time), which keeps truncation offsets deterministic.
   */
  | { kind: 'destroy-after-write'; writeIndex: number }
  /** Abrupt mid-write: destroyed once exactly `bodyBytes` decoded body bytes were sent. */
  | { kind: 'destroy-after-body-bytes'; bodyBytes: number }

export interface ResponseScript {
  status: number
  /** Reason phrase, compared strictly (a faithful proxy must not swap it). */
  reason: string
  /** Wire-order headers. Framing headers (transfer-encoding / content-length) are appended by the upstream per `framing`. */
  headers: HeaderPairs
  framing: 'chunked' | 'length'
  /** For framing 'length': explicit content-length; defaults to the sum of payload byte lengths. */
  contentLength?: number
  writes: ResponseWrite[]
  /** Defaults to { kind: 'end' }. */
  terminate?: ScriptTerminate
}

export interface FixtureJson {
  id: string
  title: string
  provenance: Provenance
  /** Coverage tags; the corpus test asserts the acceptance-criteria tags exist. */
  tags: string[]
  notes?: string
  request: {
    method: string
    target: string
    /**
     * Exact wire order. Must start with `host` (the client writes these bytes verbatim and
     * both runs must send identical request bytes, so Host is a fixed synthetic value —
     * a `.invalid` name — never derived from the ephemeral loopback port).
     */
    headers: HeaderPairs
    body: PayloadRef
  }
  response: ResponseScript
  timing?: {
    /**
     * strict: per-arrival boundaries + gaps asserted (vs baseline AND nominal).
     * boundaries: arrival COUNT + per-arrival byte boundaries asserted, gaps NOT
     *   asserted — structure is deterministic, timing is noisy; a fixture that
     *   exists to test boundary preservation at scale (fast small writes) uses
     *   this mode so scheduler jitter cannot flake a structural guarantee.
     * loose: anti-buffering + TTFB only.
     */
    mode?: 'strict' | 'boundaries' | 'loose'
    gapToleranceMs?: number
    ttfbBudgetMs?: number
  }
}

export interface ManifestFileEntry {
  sha256: string
  bytes: number
}

export interface ManifestFixtureEntry {
  id: string
  dir: string
  /** Integrity record for every file in the fixture dir (fixture.json included). */
  files: Record<string, ManifestFileEntry>
  /** Expected output of generator specs, keyed by the fixture.json path expression that uses them. */
  generated?: Record<string, { spec: GeneratorSpec; sha256: string; bytes: number }>
}

export interface Manifest {
  version: 1
  fixtures: ManifestFixtureEntry[]
}

/** One expected body-arrival event, derived from the response script (not stored). */
export interface ExpectedArrival {
  /** Nominal gap before this arrival, ms (relative to previous arrival; first: to head flush). */
  nominalGapMs: number
  /** True for the second TCP write of a splitAfterBytes write. */
  splitContinuation: boolean
}

export interface ResolvedFixture {
  id: string
  title: string
  provenance: Provenance
  tags: string[]
  notes?: string
  dir: string
  request: {
    method: string
    target: string
    headerPairs: HeaderPairs
    /** Exact request-line + headers + CRLF bytes the client writes. */
    headBytes: Buffer
    body: Buffer
  }
  response: {
    script: ResponseScript
    /** Resolved payload bytes, parallel to script.writes. */
    payloads: Buffer[]
    expectedArrivals: ExpectedArrival[]
  }
  timing: {
    mode: 'strict' | 'boundaries' | 'loose'
    gapToleranceMs: number
    ttfbBudgetMs: number
  }
}

// ---------------------------------------------------------------------------
// Observation records
// ---------------------------------------------------------------------------

export interface ArrivalEvent {
  /** Milliseconds since t0 (client: request fully written; upstream: request head complete). */
  tMs: number
  bytes: number
  cumBytes: number
}

export interface DecodedHead {
  httpVersion: string
  /** Status code (response) — for requests this is undefined and firstLine is used. */
  statusCode?: number
  reason?: string
  /** Request line fields (request heads only). */
  method?: string
  target?: string
  headers: HeaderPairs
  /** Byte length of the head including the final CRLF. */
  headByteLength: number
}

export interface ClientResult {
  requestBytesWritten: number
  /** Raw socket data events (framing bytes included) — diagnostics only, never compared directly. */
  wireEvents: ArrivalEvent[]
  /**
   * The decoded response head, or `undefined` when no head ever arrived (connect
   * failure, timeout before any byte, transport death mid-head). The absence is a
   * distinct observed fact — callers must branch on it, and `diffRuns` treats a
   * missing baseline head as a rig error and a missing SUT head as a protocol diff.
   */
  head?: DecodedHead | undefined
  /** Decoded body arrivals: one entry per socket data event that carried >=1 decoded body byte. */
  bodyEvents: ArrivalEvent[]
  body: Buffer
  /** Incremental hash (updated per arrival, never re-hashed from a buffer). */
  bodySha256: string
  /** First socket byte (head counts) minus request-written instant. */
  ttfbMs?: number | undefined
  framingComplete: boolean
  /** Present when !framingComplete: decoded body bytes received before the socket died. */
  truncatedAtBodyByte?: number | undefined
  socketError?: string | undefined
  timedOut: boolean
  aborted: boolean
  /** Request-written instant -> socket closed. */
  totalMs: number
}

export interface UpstreamRequestCapture {
  /** Exact head bytes as received on the socket. */
  headBytes: Buffer
  method: string
  target: string
  httpVersion: string
  headerPairs: HeaderPairs
  /** Body arrivals relative to head-complete instant. */
  bodyEvents: ArrivalEvent[]
  body: Buffer
  bodySha256: string
  /** Full declared content-length received. */
  bodyComplete: boolean
  declaredContentLength?: number | undefined
  clientClosedEarly: boolean
  headAtMs: number
  bodyDoneAtMs?: number | undefined
}

// ---------------------------------------------------------------------------
// System under test
// ---------------------------------------------------------------------------

export interface SutHandle {
  port: number
  stop(): Promise<void>
}

export interface Sut {
  readonly name: string
  start(ctx: { upstreamOrigin: string; upstreamPort: number }): Promise<SutHandle>
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export interface ByteRegion {
  /** Offset of the differing region in the BASELINE body (insertions: offset in baseline where sut has extra bytes). */
  offset: number
  op: 'replace' | 'insert' | 'delete'
  baseline: { len: number; hex: string; ascii: string }
  sut: { len: number; hex: string; ascii: string }
}

export interface HeaderIssue {
  issue: 'missing' | 'extra' | 'value-mismatch' | 'reordered' | 'request-line-mismatch'
  name: string
  baselinePosition?: number
  sutPosition?: number
  baselineValue?: string
  sutValue?: string
}

export interface TruncationInfo {
  framingComplete: boolean
  truncatedAtBodyByte?: number
  socketError?: string
}

export type FidelityDiff =
  | { kind: 'response-status'; baseline: { code: number; reason: string }; sut: { code: number; reason: string } }
  | { kind: 'response-headers'; issues: HeaderIssue[] }
  | {
      kind: 'response-body-bytes'
      baselineSha256: string
      sutSha256: string
      baselineLen: number
      sutLen: number
      regions: ByteRegion[]
      regionsTruncated: boolean
    }
  | {
      /** V1/A1 axis: what the upstream saw vs what the client sent, on the SUT run. */
      kind: 'upstream-request-body-bytes'
      baselineSha256: string
      sutSha256: string
      baselineLen: number
      sutLen: number
      regions: ByteRegion[]
      regionsTruncated: boolean
    }
  | { kind: 'upstream-request-headers'; issues: HeaderIssue[] }
  | {
      kind: 'arrival-count'
      classification: 'coalesced' | 'split' | 'mismatch'
      expected: number
      baseline: number
      sut: number
    }
  | { kind: 'arrival-boundary'; index: number; offset: number; baselineBytes: number; sutBytes: number }
  | {
      kind: 'arrival-gap'
      index: number
      baselineGapMs: number
      sutGapMs: number
      nominalGapMs?: number
      toleranceMs: number
      versus: 'baseline' | 'nominal'
    }
  | { kind: 'ttfb'; baselineMs: number; sutMs: number; deltaMs: number; budgetMs: number }
  | { kind: 'truncation'; baseline: TruncationInfo; sut: TruncationInfo }
  | { kind: 'protocol'; side: 'baseline' | 'sut'; detail: string }
  | { kind: 'rig-error'; detail: string }

export interface FidelityRunOptions {
  fixture: ResolvedFixture
  sut: Sut
  /** Extra header names (lowercase) to ignore on top of the hop-by-hop default set. */
  headerIgnore?: string[]
  /** Per-run client watchdog. Default 30_000. */
  clientTimeoutMs?: number
  /** Timing overrides; fixture timing block wins when absent here. */
  timing?: { mode?: 'strict' | 'loose'; gapToleranceMs?: number; ttfbBudgetMs?: number }
}

export interface RunSide {
  client: ClientResult
  /** Absent when the far end never received a request at all (e.g. a SUT that refused to forward). */
  upstream?: UpstreamRequestCapture | undefined
}

export interface FidelityRunReport {
  fixtureId: string
  sutName: string
  passed: boolean
  diffs: FidelityDiff[]
  baseline: RunSide
  sut: RunSide
  durationMs: number
}
