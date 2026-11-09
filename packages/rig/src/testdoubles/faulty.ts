/**
 * Faulty test doubles — one per mutation class the rig must never miss.
 *
 * ⚠ TEST DOUBLES, NOT OBSERVER PRODUCTION CODE. ⚠ Each double implements a REALISTIC
 * mistake (the kind an SDK-shaped implementation makes by accident), and the rig's
 * detection suite asserts that each mistake is caught by a specific diff axis:
 *
 *  - JsonRoundTripPipe   → the "obvious implementation" (spec §3.3): JSON.parse then
 *                          JSON.stringify the request. Numbers (1.0→1, 0.900→0.9),
 *                          \uXXXX escapes, and spacing die silently.
 *  - TypedModelPipe      → the serializer's three sins at once (V1/A2): drops unknown
 *                          fields (reasoning_content — absent from OpenAI's own
 *                          ChoiceDelta schema, so a typed parse deletes 100% of
 *                          reasoning on target one), drops empty fields
 *                          (""/[]/null — some dialects REQUIRE reasoning_content:""),
 *                          and reorders keys (canonical sorted stringify).
 *  - SloppyHeadersPipe   → drops x-* response headers, adds x-powered-by: header
 *                          hygiene violations (V1/A4).
 *  - CoalescingPipe      → merges arrivals into fewer, larger writes: FINAL BYTES
 *                          IDENTICAL, timing/boundaries destroyed. Undetectable
 *                          without inter-chunk-gap assertions — the reason the rig
 *                          measures arrival timelines at all.
 *  - BufferingPipe       → holds the response to completion: TTFB destroyed, one
 *                          arrival instead of N.
 *  - SseRewritingPipe    → parses each SSE event into a "typed chunk" and
 *                          re-serialises: `obfuscation` (whose ONLY purpose is to be
 *                          byte-present, §4.1) and `reasoning_content` vanish from
 *                          the stream. The §4.1 pass-through trap as working code.
 */

import { createProxySut } from './common.js'
import type { HeaderPairs, Sut } from '../types.js'

// ---------------------------------------------------------------------------
// JsonRoundTripPipe
// ---------------------------------------------------------------------------

function jsonRoundTrip(body: Buffer): Buffer {
  const parsed: unknown = JSON.parse(body.toString('utf8'))
  return Buffer.from(JSON.stringify(parsed), 'utf8')
}

export const JsonRoundTripPipe: Sut = createProxySut({
  name: 'JsonRoundTripPipe',
  transformRequest: (body) => jsonRoundTrip(body),
})

// ---------------------------------------------------------------------------
// TypedModelPipe
// ---------------------------------------------------------------------------

const KNOWN_TOP_LEVEL = new Set([
  'model', 'messages', 'stream', 'stream_options', 'temperature', 'top_p',
  'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'stop', 'n',
  'presence_penalty', 'frequency_penalty', 'seed', 'user', 'response_format',
  'logprobs', 'top_logprobs', 'parallel_tool_calls', 'service_tier', 'store',
  'metadata', 'logit_bias', 'prompt_cache_key', 'safety_identifier',
])
const KNOWN_MESSAGE = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'refusal', 'audio', 'function_call'])
const KNOWN_TOOL_CALL = new Set(['index', 'id', 'type', 'function'])
const KNOWN_TOOL_CALL_FUNCTION = new Set(['name', 'arguments'])
const KNOWN_TOOL = new Set(['type', 'function'])
const KNOWN_TOOL_FUNCTION = new Set(['name', 'description', 'parameters', 'strict'])

function isEmptyValue(v: unknown): boolean {
  return v === '' || v === null || (Array.isArray(v) && v.length === 0)
}

/** Sin (ii): empty fields dropped. Some dialects REQUIRE `reasoning_content: ""`. */
function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!isEmptyValue(v)) out[k] = v
  return out
}

function projectToolCall(tc: unknown): unknown {
  if (typeof tc !== 'object' || tc === null) return tc
  const o = tc as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of KNOWN_TOOL_CALL) if (k in o) out[k] = o[k]
  if (typeof out['function'] === 'object' && out['function'] !== null) {
    const f = out['function'] as Record<string, unknown>
    const fo: Record<string, unknown> = {}
    for (const k of KNOWN_TOOL_CALL_FUNCTION) if (k in f) fo[k] = f[k]
    out['function'] = fo
  }
  return out
}

/** Sin (i): unknown fields dropped — including `reasoning_content` on assistant messages. */
function projectMessage(m: unknown): unknown {
  if (typeof m !== 'object' || m === null) return m
  const o = m as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of KNOWN_MESSAGE) if (k in o) out[k] = o[k]
  if (Array.isArray(out['tool_calls'])) out['tool_calls'] = out['tool_calls'].map(projectToolCall)
  return out
}

function projectTool(t: unknown): unknown {
  if (typeof t !== 'object' || t === null) return t
  const o = t as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of KNOWN_TOOL) if (k in o) out[k] = o[k]
  if (typeof out['function'] === 'object' && out['function'] !== null) {
    const f = out['function'] as Record<string, unknown>
    const fo: Record<string, unknown> = {}
    for (const k of KNOWN_TOOL_FUNCTION) if (k in f) fo[k] = f[k]
    out['function'] = fo
  }
  return out
}

function projectRequest(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed
  const o = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of KNOWN_TOP_LEVEL) if (k in o) out[k] = o[k]
  if (Array.isArray(out['messages'])) out['messages'] = out['messages'].map(projectMessage)
  if (Array.isArray(out['tools'])) out['tools'] = out['tools'].map(projectTool)
  return out
}

/** Sin (iii): key order changed — canonical sorted-key stringify, recursively. */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const TypedModelPipe: Sut = createProxySut({
  name: 'TypedModelPipe',
  transformRequest: (body) => {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    const projected = stripEmpty(projectRequest(parsed) as Record<string, unknown>)
    if (Array.isArray(projected['messages'])) {
      projected['messages'] = (projected['messages'] as unknown[]).map((m) =>
        typeof m === 'object' && m !== null ? stripEmpty(m as Record<string, unknown>) : m,
      )
    }
    return Buffer.from(canonicalStringify(projected), 'utf8')
  },
})

// ---------------------------------------------------------------------------
// SloppyHeadersPipe
// ---------------------------------------------------------------------------

export const SloppyHeadersPipe: Sut = createProxySut({
  name: 'SloppyHeadersPipe',
  transformResponseHeaders: (pairs: HeaderPairs) => {
    const out = pairs.filter(([n]) => !n.toLowerCase().startsWith('x-'))
    out.push(['x-powered-by', 'sloppy-test-double'])
    return out
  },
})

// ---------------------------------------------------------------------------
// CoalescingPipe / BufferingPipe / SseRewritingPipe
// ---------------------------------------------------------------------------

export const CoalescingPipe: Sut = createProxySut({
  name: 'CoalescingPipe',
  bodyStrategy: { kind: 'coalesce', maxBytes: 32_768, idleMs: 100 },
})

export const BufferingPipe: Sut = createProxySut({
  name: 'BufferingPipe',
  bodyStrategy: { kind: 'buffer-all' },
})

/**
 * The "typed chunk" projection an OpenAI-SDK-shaped implementation would apply to
 * each streamed chunk. `obfuscation`, `system_fingerprint`-adjacent unknowns, and
 * `delta.reasoning_content` are not in the official schema — so they die here,
 * silently, with no test failing anywhere downstream of a typed parser.
 */
const KNOWN_CHUNK = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'service_tier'])
const KNOWN_CHOICE = new Set(['index', 'delta', 'finish_reason', 'logprobs'])
const KNOWN_DELTA = new Set(['role', 'content', 'tool_calls', 'refusal', 'function_call', 'audio'])

function projectChunk(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed
  const o = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of KNOWN_CHUNK) if (k in o) out[k] = o[k]
  if (Array.isArray(out['choices'])) {
    out['choices'] = (out['choices'] as unknown[]).map((c) => {
      if (typeof c !== 'object' || c === null) return c
      const co = c as Record<string, unknown>
      const cOut: Record<string, unknown> = {}
      for (const k of KNOWN_CHOICE) if (k in co) cOut[k] = co[k]
      if (typeof cOut['delta'] === 'object' && cOut['delta'] !== null) {
        const d = cOut['delta'] as Record<string, unknown>
        const dOut: Record<string, unknown> = {}
        for (const k of KNOWN_DELTA) if (k in d) dOut[k] = d[k]
        cOut['delta'] = dOut
      }
      return cOut
    })
  }
  return out
}

export const SseRewritingPipe: Sut = createProxySut({
  name: 'SseRewritingPipe',
  bodyStrategy: { kind: 'sse-rewrite', transformEvent: projectChunk },
})

export const FAULTY_DOUBLES: readonly Sut[] = [
  JsonRoundTripPipe,
  TypedModelPipe,
  SloppyHeadersPipe,
  CoalescingPipe,
  BufferingPipe,
  SseRewritingPipe,
]
