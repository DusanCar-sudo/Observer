/**
 * The V1 gateway: a thin policy layer over @observer/capture's proxy core.
 *
 * Division of labour (spec §1): the byte-faithful pipeline lives ONCE in the
 * capture package's proxy-core — keep-alive sequencing, the write-behind
 * finalize race (§9.4), truncation propagation, backpressure, Host-only byte
 * splice — and is judged once by the rig. This file adds exactly what V1 owns:
 * routing/refusals (A8 corrected, §9.1), statistics (counted and visible),
 * capture policy (fail-open, poisoned-recorder-tested), and the startup refusal
 * to pretend at unimplementable enforcement (refuseOnBodyShape).
 *
 * There is NO JSON serializer anywhere in this package. Not "careful use" —
 * none. The a2 test suite scans the source to keep it that way, because the
 * three serializer sins (dropped unknown fields, dropped empty fields,
 * reordered keys) are undetectable on target one at runtime: qwen applies no
 * prefix check and reasoning carries no signature, so these tests are the only
 * detection that exists.
 */

import { CaptureRecorder, NULL_CAPTURE, startProxy, type ProxyCoreHandle, type ProxyEvent, type RecorderLike } from '@observer/capture'
import { validateGatewayConfig, type GatewayConfig } from './config.js'
import { decideRoute } from './route.js'
import { StatsCollector, type GatewayStats } from './stats.js'

const NULL_RECORDER: RecorderLike = { begin: () => NULL_CAPTURE }

export interface GatewayHandle {
  port: number
  origin: string
  /** Resolved capture directory (undefined when capture is disabled or a recorder was injected). */
  outDir?: string | undefined
  captureIds(): string[]
  /** Live counters — refusals, truncations, capture failures, misdialect verdicts. */
  stats(): GatewayStats
  stop(): Promise<void>
}

export async function startGateway(cfg: GatewayConfig): Promise<GatewayHandle> {
  validateGatewayConfig(cfg)
  const stats = new StatsCollector()

  const recorder: RecorderLike | undefined =
    cfg.recorder ?? (cfg.capture === false ? NULL_RECORDER : undefined)

  const core: ProxyCoreHandle = await startProxy({
    ...(cfg.listenHost === undefined ? {} : { listenHost: cfg.listenHost }),
    ...(cfg.listenPort === undefined ? {} : { listenPort: cfg.listenPort }),
    upstreamOrigin: cfg.upstreamOrigin,
    ...(cfg.captureOutDir === undefined ? {} : { outDir: cfg.captureOutDir }),
    ...(recorder === undefined ? {} : { recorder }),
    // Production default: rewrite Host to the upstream authority (providers
    // reject foreign Host). Rig conformance disables it to prove byte identity.
    rewriteHost: cfg.rewriteHost ?? true,
    // V1/A4: hop-by-hop request headers are stripped at the byte level (line
    // excision; everything else preserved verbatim). The tap does NOT do this —
    // its contract forwards the head untouched — which is why the flag defaults
    // off in the core and the gateway opts in here.
    stripRequestHopByHop: true,
    ...(cfg.tlsRejectUnauthorized === undefined ? {} : { tlsRejectUnauthorized: cfg.tlsRejectUnauthorized }),
    ...(cfg.upstreamConnectTimeoutMs === undefined ? {} : { upstreamConnectTimeoutMs: cfg.upstreamConnectTimeoutMs }),
    route: decideRoute,
    onEvent: (ev: ProxyEvent) => {
      stats.onEvent(ev)
      try {
        cfg.onEvent?.(ev)
      } catch {
        // external observer hooks must not break traffic (I1); the core already
        // guards its own emit, this guards the user-supplied chain
      }
    },
    syntheticMarkerHeader: ['x-observer-gateway', 'v1'],
    label: 'gateway',
  })

  return {
    port: core.port,
    origin: core.origin,
    ...(core.outDir !== undefined ? { outDir: core.outDir } : {}),
    captureIds: () => core.captureIds(),
    stats: () => stats.snapshot(),
    stop: () => core.stop(),
  }
}

/**
 * Fail-open proof support: a recorder whose every operation throws. A6 requires
 * that killing the store mid-request leaves traffic byte-perfect and the failure
 * COUNTED (never silent). Tests wire this via cfg.recorder.
 */
export const POISONED_RECORDER: RecorderLike = {
  begin(): never {
    throw new Error('poisoned recorder: store is dead (A6 test)')
  },
}
