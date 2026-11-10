/**
 * Gateway statistics — the "counted and visible" half of spec §9.1 condition 1.
 *
 * A number nobody reads repeats the warn-scope mistake (docs/research/
 * lead-verification-feelin.md): FEEL warnings fired 40k times in production and
 * nothing surfaced them, so they protected nothing. Every refusal reason, every
 * capture failure, every truncation is counted here, exposed on the handle, and
 * (later, V9) rendered on the dashboard. The misdialect counter exists from day
 * one even though milestone 1 has no parser to feed it: the slot being visible
 * and permanently zero is itself the claim being made ("we saw nothing we did
 * not understand"), and V3 feeds it without a schema change.
 */

import type { ProxyEvent } from '@observer/capture'

export interface GatewayStats {
  exchanges: number
  forwarded: number
  /** Refusals keyed by reason (route marker, or core structural reasons). */
  refused: Record<string, number>
  responsesComplete: number
  responsesTruncated: number
  clientAborted: number
  upstreamConnectFailed: number
  /** Capture/recorder failures — traffic continued regardless (I1); the loss is counted, never silent. */
  captureErrors: number
  /**
   * §9.1: "not OpenAI Chat Completions shape" verdicts from V3's permissive
   * parse of a copy. Always 0 in milestone 1 (no parser). Nonzero during
   * ordinary DSH→qwen operation would mean OUR dialect assumption is wrong —
   * a finding about Observer, not about the traffic.
   */
  misdialectVerdicts: number
}

export class StatsCollector {
  #stats: GatewayStats = {
    exchanges: 0,
    forwarded: 0,
    refused: {},
    responsesComplete: 0,
    responsesTruncated: 0,
    clientAborted: 0,
    upstreamConnectFailed: 0,
    captureErrors: 0,
    misdialectVerdicts: 0,
  }

  onEvent(ev: ProxyEvent): void {
    switch (ev.kind) {
      case 'exchange-start':
        this.#stats.exchanges++
        break
      case 'forwarded':
        this.#stats.forwarded++
        break
      case 'refused': {
        const key = ev.reason
        this.#stats.refused[key] = (this.#stats.refused[key] ?? 0) + 1
        break
      }
      case 'response-complete':
        this.#stats.responsesComplete++
        break
      case 'response-truncated':
        this.#stats.responsesTruncated++
        break
      case 'client-aborted':
        this.#stats.clientAborted++
        break
      case 'upstream-connect-failed':
        this.#stats.upstreamConnectFailed++
        break
      case 'capture-error':
        this.#stats.captureErrors++
        break
    }
  }

  /** V3 hook: feed body-shape verdicts here so the counter is live the day the parser lands. */
  noteMisdialectVerdict(): void {
    this.#stats.misdialectVerdicts++
  }

  snapshot(): GatewayStats {
    return { ...this.#stats, refused: { ...this.#stats.refused } }
  }
}
