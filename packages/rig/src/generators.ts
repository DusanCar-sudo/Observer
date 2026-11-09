/**
 * Deterministic fixture payload generators.
 *
 * WHY GENERATORS: the V0 acceptance criteria require a request body >5 MB, and real
 * 1M-token-context bodies exceed 10 MB. Committing those to git is the wrong trade
 * (spec §3: "budget for a fixture store outside git plus a checked-in subset"). A
 * seeded generator keeps the giant fixture out of the repo while remaining
 * byte-exact everywhere: the manifest pins the generated output's sha256 and length,
 * so any platform whose output drifts even one byte fails the fixture load — loudly.
 *
 * Determinism contract: pure integer/string math from the seed. No Math.random, no
 * Date, no locale APIs, no platform-dependent iteration order. If you touch this file,
 * the corpus manifest must be regenerated (tools/build-fixtures.mjs) and the change
 * must be deliberate: the pinned hashes are what make "generated" fixtures auditable.
 */

import type { GeneratorSpec } from './types.js'

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. Pure integer math. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A fixed vocabulary keeps output stable across locales/versions. Words are bland on
// purpose: fixtures must not carry anything that looks like real user content.
const NOUNS = [
  'buffer', 'cache', 'chunk', 'client', 'context', 'cursor', 'delta', 'encoder', 'event', 'fixture',
  'frame', 'gateway', 'handler', 'hash', 'header', 'index', 'kernel', 'ledger', 'listener', 'manifest',
  'offset', 'parser', 'payload', 'pipeline', 'prefix', 'prompt', 'provider', 'proxy', 'queue', 'record',
  'request', 'response', 'schema', 'segment', 'sequence', 'server', 'session', 'socket', 'stream', 'suffix',
  'supervisor', 'symbol', 'syntax', 'system', 'table', 'template', 'threshold', 'timeline', 'token', 'transcript',
] as const

const VERBS = [
  'advances', 'arrives', 'binds', 'buffers', 'carries', 'chunks', 'coalesces', 'compares', 'contains', 'decodes',
  'delivers', 'diffs', 'drains', 'emits', 'encodes', 'ends', 'flushes', 'forwards', 'hashes', 'holds',
  'indexes', 'merges', 'normalises', 'omits', 'parses', 'passes', 'preserves', 'produces', 'receives', 'records',
  'reorders', 'repeats', 'resets', 'serialises', 'splits', 'starts', 'streams', 'terminates', 'truncates', 'writes',
] as const

const ADJS = [
  'abrupt', 'append-only', 'byte-exact', 'canonical', 'chunked', 'coalesced', 'compressed', 'deterministic',
  'duplicate', 'empty', 'encoded', 'exact', 'final', 'incremental', 'interleaved', 'literal', 'lossless',
  'mid-frame', 'nominal', 'non-streaming', 'observable', 'ordered', 'parallel', 'partial', 'positional',
  'premature', 'raw', 'repeated', 'scheduled', 'sequential', 'silent', 'split', 'streamed', 'synthetic',
  'truncated', 'typed', 'unaltered', 'unbuffered', 'unknown', 'verbatim',
] as const

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length] as T
}

function sentence(rnd: () => number): string {
  const patterns = [
    () => `The ${pick(rnd, ADJS)} ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)} before the ${pick(rnd, ADJS)} ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)}.`,
    () => `A ${pick(rnd, NOUNS)} that ${pick(rnd, VERBS)} keeps the ${pick(rnd, NOUNS)} ${pick(rnd, ADJS)} while every ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)}.`,
    () => `If the ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)}, the ${pick(rnd, ADJS)} ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)} exactly once and the ${pick(rnd, NOUNS)} stays ${pick(rnd, ADJS)}.`,
    () => `Each ${pick(rnd, ADJS)} ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)}; no ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)} twice while the ${pick(rnd, NOUNS)} remains ${pick(rnd, ADJS)}.`,
  ]
  return pick(rnd, patterns)()
}

function paragraph(rnd: () => number, sentences: number): string {
  const out: string[] = []
  for (let i = 0; i < sentences; i++) out.push(sentence(rnd))
  return out.join(' ')
}

/** A deterministic tool-result-ish blob (file listing / command output flavour). */
function toolResultText(rnd: () => number): string {
  const lines: string[] = []
  const n = 6 + Math.floor(rnd() * 10)
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(rnd() * 3)
    if (kind === 0) {
      lines.push(`-rw-r--r-- 1 user group ${1000 + Math.floor(rnd() * 90000)} Nov  9 12:0${Math.floor(rnd() * 10)} ${pick(rnd, NOUNS)}_${i}.txt`)
    } else if (kind === 1) {
      lines.push(`${i + 1}: the ${pick(rnd, ADJS)} ${pick(rnd, NOUNS)} ${pick(rnd, VERBS)} at offset ${Math.floor(rnd() * 100000)}`)
    } else {
      lines.push(`[${pick(rnd, NOUNS)}] ${pick(rnd, VERBS)} ${pick(rnd, ADJS)} ${pick(rnd, NOUNS)} (${Math.floor(rnd() * 1000)} ms)`)
    }
  }
  return lines.join('\n')
}

/**
 * A realistic-shaped Chat Completions request whose body is at least `targetBytes`.
 * Valid JSON, compact separators (what SDKs actually send), messages alternating
 * user / assistant-with-tool-call / tool-result so the bulk sits where real bulk sits:
 * inside message content strings.
 */
export function bigChatBody(spec: Extract<GeneratorSpec, { kind: 'big-chat-body' }>): Buffer {
  const rnd = mulberry32(spec.seed)
  const messages: string[] = []

  const systemText =
    'You are a test fixture generator output. Behave like a large conversation context: ' +
    'many turns, tool calls, tool results, and long content blocks. ' +
    paragraph(rnd, 6)
  messages.push(JSON.stringify({ role: 'system', content: systemText }))

  let totalBytes = 256 // head room for envelope + separators
  let turn = 0
  while (totalBytes < spec.targetBytes) {
    turn++
    const userText = paragraph(rnd, 3 + Math.floor(rnd() * 6))
    const userMsg = JSON.stringify({ role: 'user', content: userText })
    messages.push(userMsg)
    totalBytes += Buffer.byteLength(userMsg) + 1

    const callId = `call_fixture_${spec.seed}_${turn}`
    const args = JSON.stringify({
      command: `grep -n "${pick(rnd, NOUNS)}" src/${pick(rnd, NOUNS)}_${turn % 97}.ts | head -${5 + (turn % 20)}`,
      description: `inspect the ${pick(rnd, ADJS)} ${pick(rnd, NOUNS)} (fixture turn ${turn})`,
    })
    const assistantMsg = JSON.stringify({
      role: 'assistant',
      content: null,
      reasoning_content: paragraph(rnd, 2 + Math.floor(rnd() * 4)),
      tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'bash', arguments: args } }],
    })
    messages.push(assistantMsg)
    totalBytes += Buffer.byteLength(assistantMsg) + 1

    // Bulk: a long tool result. Deterministic, bland, sizeable.
    const chunks: string[] = []
    let resultBytes = 0
    const wanted = 8_000 + Math.floor(rnd() * 24_000)
    while (resultBytes < wanted) {
      const piece =
        Math.floor(rnd() * 4) === 0
          ? toolResultText(rnd)
          : paragraph(rnd, 4 + Math.floor(rnd() * 8))
      chunks.push(piece)
      resultBytes += Buffer.byteLength(piece) + 1
    }
    const toolMsg = JSON.stringify({
      role: 'tool',
      tool_call_id: callId,
      name: 'bash',
      content: chunks.join('\n'),
    })
    messages.push(toolMsg)
    totalBytes += Buffer.byteLength(toolMsg) + 1

    if (turn % 4 === 0) {
      const assistantText = paragraph(rnd, 4 + Math.floor(rnd() * 8))
      const doneMsg = JSON.stringify({ role: 'assistant', content: assistantText })
      messages.push(doneMsg)
      totalBytes += Buffer.byteLength(doneMsg) + 1
    }
  }

  const envelopeHead =
    '{"model":"qwen3.8-max","messages":['
  const envelopeTail =
    '],"stream":false,"temperature":0.2,"max_tokens":4096,"tool_choice":"auto","fixture":{"generator":"big-chat-body","seed":' +
    spec.seed +
    ',"targetBytes":' +
    spec.targetBytes +
    '}}'
  const body = envelopeHead + messages.join(',') + envelopeTail
  const buf = Buffer.from(body, 'utf8')
  if (buf.byteLength < spec.targetBytes) {
    // Should be unreachable (the loop overshoots by construction); fail loudly rather
    // than emit an under-sized "big body" fixture.
    throw new Error(`bigChatBody produced ${buf.byteLength} bytes < targetBytes ${spec.targetBytes}`)
  }
  return buf
}

export function runGenerator(spec: GeneratorSpec): Buffer {
  switch (spec.kind) {
    case 'big-chat-body':
      return bigChatBody(spec)
  }
}
