/**
 * Gateway configuration.
 *
 * Milestone-1 stance (P3): observe only. The gateway forwards bytes, records
 * bytes, refuses what it does not support, and mutates NOTHING. Every knob here
 * that could ever change traffic is either absent or fails fast at startup
 * rather than degrading silently.
 */

import type { RecorderLike } from '@observer/capture'

export interface GatewayConfig {
  /** Default 127.0.0.1. */
  listenHost?: string
  /** Default 0 (ephemeral). A deployed gateway pins a port the DSH baseURL points at. */
  listenPort?: number
  /** Real provider origin, e.g. https://token-plan.ap-southeast-1.maas.aliyuncs.com */
  upstreamOrigin: string
  /** Capture store directory. Default ./observer-data/captures (gitignored). */
  captureOutDir?: string
  /** Set false to run without capture (still counted, still zero-mutation). Default true. */
  capture?: boolean
  /**
   * Splice the Host header to the upstream authority (real providers reject
   * foreign Host values). Default true. Rig conformance runs set false so the
   * gateway can be proven byte-identical end to end.
   */
  rewriteHost?: boolean
  tlsRejectUnauthorized?: boolean
  upstreamConnectTimeoutMs?: number
  /**
   * Spec §9.1 condition 2: hard body-shape refusal sits behind this flag,
   * DEFAULTS OFF, and only becomes effective at V3+ when a real permissive parse
   * exists. In milestone 1 there is no parser, so requesting `true` FAILS
   * STARTUP — the gateway refuses to pretend it can enforce something it cannot
   * see. When V3 wires it, flipping the flag must be recorded in the actuation
   * log (I2); that wiring lands with V3, not here.
   */
  refuseOnBodyShape?: boolean
  /** Recorder injection (tests poison this to prove A6 fail-open). */
  recorder?: RecorderLike
  /** External event tap (dashboard/metrics later). Must not throw; wrapped anyway. */
  onEvent?: (ev: import('@observer/capture').ProxyEvent) => void
}

export function validateGatewayConfig(cfg: GatewayConfig): void {
  if (cfg.refuseOnBodyShape === true) {
    throw new Error(
      'refuseOnBodyShape=true is not implementable in milestone 1: there is no body parser yet (V3). ' +
        'The gateway refuses to pretend to enforce a check it cannot perform. Leave the flag unset/false; ' +
        'it becomes effective — behind an actuation-log record per spec §9.1 — when V3 lands.',
    )
  }
}
