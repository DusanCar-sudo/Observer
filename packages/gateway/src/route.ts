/**
 * A8 routing — the CORRECTED criterion (spec §9.1).
 *
 * The original A8 wording implied scanning request BODIES for dialect markers
 * like `tools[].input_schema`. That was wrong and dangerous: the marker can
 * appear inside message CONTENT — any session that merely discusses Anthropic's
 * schema (our own design docs do, constantly) would have its legitimate qwen
 * traffic refused. The supervisor breaking the supervised agent over
 * conversation content, with no provider-side alarm on target one, is precisely
 * this project's failure class.
 *
 * Corrected rule: refuse only on signals message content CANNOT spoof.
 *
 *  1. PATH (hard). Serve only `POST /v1/chat/completions`. Endpoint constants
 *     verified [SRC]: pi-ai drives the Anthropic SDK via client.beta.messages.create
 *     (anthropic-messages.js:447) and the SDK posts '/v1/messages'
 *     (@anthropic-ai/sdk messages.js:36); the OpenAI SDK posts '/chat/completions'
 *     (completions.js:24) under the /v1 baseURL (openai-completions.js:197).
 *     `/v1/responses` gets the spec-named explicit 501 unsupported-protocol.
 *  2. HEADER (hard). `anthropic-version` present → 501. Zero false positives:
 *     no legitimate OpenAI-compatible chat request carries it.
 *  3. BODY SHAPE (soft in milestone 1). V3's permissive parse of a COPY will
 *     record a "not OpenAI Chat Completions shape" verdict on the capture and
 *     the misdialectVerdicts counter (counted and visible — §9.1 condition 1);
 *     traffic is still forwarded faithfully, because milestone 1 mutates nothing
 *     and a misdialect body passing through untouched harms nothing. A8's spirit
 *     is "never NORMALISE a dialect we have not implemented" — pass-through does
 *     not normalise.
 *
 * Refusal bodies are STATIC STRINGS. This module contains no JSON serializer —
 * the gateway has none anywhere (see the a2 src-scan test), because the first
 * serializer is the beginning of the end of byte identity.
 */

import type { ProxyRequestInfo, RouteDecision, SyntheticResponse } from '@observer/capture'

export const SUPPORTED_METHOD = 'POST'
export const SUPPORTED_PATH = '/v1/chat/completions'

const REFUSAL_BODY_UNSUPPORTED_PROTOCOL =
  '{"error":{"message":"Observer gateway: unsupported protocol. Milestone 1 serves exactly one configuration: POST /v1/chat/completions (OpenAI-compatible Chat Completions, DSH -> qwen as deployed). Everything else is refused explicitly rather than best-efforted — see docs/spec/vertical-slice-tasks.md V1/A8 and §9.1.","type":"unsupported_protocol","code":"unsupported-protocol"}}'

const REFUSAL_BODY_UNSUPPORTED_METHOD =
  '{"error":{"message":"Observer gateway: method not supported. This gateway serves POST /v1/chat/completions only.","type":"unsupported_protocol","code":"unsupported-method"}}'

const REFUSAL_BODY_ANTHROPIC =
  '{"error":{"message":"Observer gateway: anthropic-version header present — this is an Anthropic Messages request shape. The Anthropic adapter is not implemented in milestone 1 and is refused explicitly (never best-efforted).","type":"unsupported_protocol","code":"unsupported-protocol-anthropic"}}'

function refusal(status: number, reason: string, body: string, marker: string): { kind: 'refuse'; reason: string; response: SyntheticResponse } {
  return {
    kind: 'refuse',
    reason: marker,
    response: {
      status,
      reason,
      body,
      contentType: 'application/json',
    },
  }
}

export function decideRoute(info: ProxyRequestInfo): RouteDecision {
  // Header check first: it is protocol-family evidence independent of path.
  for (const [name] of info.headerPairs) {
    if (name.toLowerCase() === 'anthropic-version') {
      return refusal(501, 'Not Implemented', REFUSAL_BODY_ANTHROPIC, 'anthropic-version-header')
    }
  }

  // Path check ignores any query string.
  const q = info.target.indexOf('?')
  const pathOnly = q === -1 ? info.target : info.target.slice(0, q)

  if (pathOnly === SUPPORTED_PATH) {
    if (info.method !== SUPPORTED_METHOD) {
      return refusal(501, 'Not Implemented', REFUSAL_BODY_UNSUPPORTED_METHOD, 'unsupported-method')
    }
    return { kind: 'forward' }
  }
  if (pathOnly === '/v1/responses') {
    // Spec-named explicit refusal: the Responses API has the unsolved
    // R-server-state injection question (gap A15) and often carries no
    // transcript on the wire at all (§5.3). Not in this slice. The reason
    // marker carries the spec's own name for this refusal.
    return refusal(501, 'Not Implemented', REFUSAL_BODY_UNSUPPORTED_PROTOCOL, 'unsupported-protocol')
  }
  // Everything else — including Anthropic's /v1/messages — is refused.
  return refusal(501, 'Not Implemented', REFUSAL_BODY_UNSUPPORTED_PROTOCOL, `unsupported-path:${pathOnly}`)
}
