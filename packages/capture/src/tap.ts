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

/*
 * This module is deliberately THIN. The byte-faithful pipeline — keep-alive
 * exchange sequencing, the write-behind finalize race, truncation propagation,
 * backpressure, the Host-only splice — lives once in ./proxy-core.ts and is
 * judged there by the rig and by every test that reaches it through startTap().
 * Spec §1: "two components that both 'guarantee' byte fidelity produce a
 * guarantee nobody tests." The tap is now just the V0a policy layer: forward
 * unconditionally, record everything.
 */

import { startProxy } from './proxy-core.js'
import type { TapConfig, TapHandle } from './types.js'

const FORWARD_ALL = (): { kind: 'forward' } => ({ kind: 'forward' })

/**
 * Start the V0a logging tap. `route` is hard-wired to forward: V0a has no policy
 * layer, so the tap can never refuse a request the gateway would allow.
 */
export async function startTap(cfg: TapConfig): Promise<TapHandle> {
  const core = await startProxy({
    ...(cfg.listenHost === undefined ? {} : { listenHost: cfg.listenHost }),
    ...(cfg.listenPort === undefined ? {} : { listenPort: cfg.listenPort }),
    upstreamOrigin: cfg.upstreamOrigin,
    ...(cfg.outDir === undefined ? {} : { outDir: cfg.outDir }),
    ...(cfg.rewriteHost === undefined ? {} : { rewriteHost: cfg.rewriteHost }),
    ...(cfg.tlsRejectUnauthorized === undefined ? {} : { tlsRejectUnauthorized: cfg.tlsRejectUnauthorized }),
    ...(cfg.upstreamConnectTimeoutMs === undefined
      ? {}
      : { upstreamConnectTimeoutMs: cfg.upstreamConnectTimeoutMs }),
    route: FORWARD_ALL,
  })

  if (core.outDir === undefined) {
    // The tap always owns a recorder, so a missing outDir means the core changed
    // shape underneath us. Fail loudly rather than hand back an unusable handle.
    throw new Error('startTap: proxy core returned no capture outDir')
  }
  const outDir: string = core.outDir

  return {
    port: core.port,
    origin: core.origin,
    outDir,
    captureIds: () => core.captureIds(),
    stop: () => core.stop(),
  }
}
