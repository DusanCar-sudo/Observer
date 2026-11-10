#!/usr/bin/env node
/**
 * Build (or verify) the V0 fixture corpus under fixtures/corpus/.
 *
 * WHY A BUILDER: the corpus is the evidence base for every later acceptance
 * criterion ("verified on every fixture"). Hand-editing 28 fixture directories
 * invites silent drift between a fixture's bytes and its manifest hashes, so the
 * corpus is generated from this one script and pinned by sha256 in manifest.json.
 * The rig's loader re-verifies every hash at load time, and CI runs --check so a
 * drifted corpus fails the build instead of quietly testing the wrong bytes.
 *
 * Provenance honesty: until the V0a tap captures real wire bytes, everything here
 * is synthetic, derived (the real 40-tool DSH header), or generated (the >5 MB
 * body). Every fixture declares which; the loader refuses to run a fixture whose
 * bytes do not match their manifest record.
 *
 * Usage:
 *   node tools/build-fixtures.mjs           # rebuild corpus + manifest (deterministic
 *                                           #   except gzip bytes, which are zlib-version
 *                                           #   dependent and only rewritten here)
 *   node tools/build-fixtures.mjs --check   # verify disk == this script's output
 *                                           #   (gzip files verified by manifest hash,
 *                                           #   not re-compression)
 *
 * Requires the rig to be built first (uses dist/generators.js):
 *   pnpm --filter @observer/rig build
 */

import { createHash } from 'node:crypto'
import { brotliCompressSync, gzipSync, gunzipSync, brotliDecompressSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS = path.join(ROOT, 'fixtures', 'corpus')
const DERIVED_HEADER = path.join(ROOT, 'fixtures', 'derived', 'dsh-qwen-40-tools.header.json')
const CHECK = process.argv.includes('--check')

let generators
try {
  generators = await import(new URL('../packages/rig/dist/generators.js', import.meta.url).href)
} catch {
  console.error('build-fixtures: packages/rig/dist/generators.js not found.\n  run: pnpm --filter @observer/rig build')
  process.exit(1)
}
const { bigChatBody, mulberry32 } = generators

// ---------------------------------------------------------------------------
// Constants — fixed and synthetic. Nothing here may look like a real credential.
// ---------------------------------------------------------------------------

const MODEL = 'qwen3.8-max'
const CREATED = 1794216900
const FP = 'fp_obsfixture'
const DATE = 'Sun, 09 Nov 2026 14:00:00 GMT' // pinned: the rig compares Date strictly
const AUTH = 'Bearer sk-observer-fixture-not-a-real-key'
const UA = 'observer-rig-fixture/0.1 (synthetic corpus; not a real client)'
const SYSTEM_SHORT = 'You are a synthetic test agent inside the Observer fixture corpus. Nothing in this conversation is real.'

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const utf8 = (s) => Buffer.from(s, 'utf8')

// --- SSE helpers: byte-exact event text, deterministic key order -------------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const DONE = 'data: [DONE]\n\n'

function chunk(id, choices, extra = {}) {
  return { id, object: 'chat.completion.chunk', created: CREATED, model: MODEL, system_fingerprint: FP, choices, ...extra }
}
function delta(id, deltaObj, extra = {}) {
  return chunk(id, [{ index: 0, delta: deltaObj, finish_reason: null }], extra)
}
function finish(id, reason, extra = {}) {
  return chunk(id, [{ index: 0, delta: {}, finish_reason: reason }], extra)
}
function roleChunk(id, extraDelta = {}, extra = {}) {
  return delta(id, { role: 'assistant', content: '', ...extraDelta }, extra)
}

const OBF_ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'
/** Deterministic obfuscation-ish padding; varies in length per chunk like the real field. */
function obf(i) {
  let s = ''
  const n = 8 + ((i * 7) % 23)
  for (let k = 0; k < n; k++) s += OBF_ALPHA[(i * 31 + k * 17) % OBF_ALPHA.length]
  return s
}

// --- request header block (identical bytes on both runs; host is synthetic) --

function requestHeaders(bodyLen, { stream = false, retryCount = '0' } = {}) {
  return [
    ['host', 'qwen-api.invalid'], // synthetic, .invalid TLD: never resolvable, never port-derived
    ['content-type', 'application/json'],
    ['authorization', AUTH],
    ['accept', stream ? 'text/event-stream' : '*/*'],
    ['user-agent', UA],
    ['openai-organization', 'org-observer-fixture'],
    ['openai-project', 'proj-observer-fixture'],
    ['x-stainless-lang', 'js'],
    ['x-stainless-package-version', '7.19.0'],
    ['x-stainless-runtime', 'node'],
    ['x-stainless-runtime-version', '26.13.0'],
    ['x-stainless-retry-count', retryCount],
    ['accept-encoding', 'gzip, deflate'],
    ['connection', 'close'],
    ['content-length', String(bodyLen)],
  ]
}

function jsonResHeaders(extra = []) {
  return [['date', DATE], ['content-type', 'application/json'], ...extra, ['connection', 'close']]
}
function sseResHeaders(extra = []) {
  return [
    ['date', DATE],
    ['content-type', 'text/event-stream; charset=utf-8'],
    ['cache-control', 'no-store, no-cache, must-revalidate'],
    ...extra,
    ['connection', 'close'],
  ]
}

function completion(id, messageExtra, usage, content) {
  return JSON.stringify({
    id,
    object: 'chat.completion',
    created: CREATED,
    model: MODEL,
    system_fingerprint: FP,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: content ?? 'Fixture response body — non-streaming.', refusal: null, ...messageExtra },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage,
  })
}
const USAGE_SMALL = {
  prompt_tokens: 42,
  completion_tokens: 9,
  total_tokens: 51,
  prompt_tokens_details: { cached_tokens: 32 },
  completion_tokens_details: { reasoning_tokens: 0 },
}

function nonstreamResponse(id, messageExtra = {}, usage = USAGE_SMALL, content, delayMs = 10, headersExtra = []) {
  return {
    status: 200,
    reason: 'OK',
    headers: jsonResHeaders(headersExtra),
    framing: 'length',
    writes: [{ payload: completion(id, messageExtra, usage, content), delayMs }],
  }
}

function simpleRequest(userContent, extra = {}) {
  return JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_SHORT },
      { role: 'user', content: userContent },
    ],
    stream: false,
    temperature: 0.2,
    max_tokens: 1024,
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

const defs = []
const def = (d) => defs.push(d)

// ---- 1. real 40-tool request (derived from a logged DSH->qwen header) -------
{
  const derived = JSON.parse(readFileSync(DERIVED_HEADER, 'utf8'))
  const tools = derived.tools.map((t) => ({ type: 'function', function: t }))
  const body = JSON.stringify({
    model: derived.config.model,
    messages: [
      {
        role: 'system',
        content:
          'You are a coding agent operating inside the Observer fixture corpus. Follow the tool contract exactly. Nothing in this conversation is real.',
      },
      { role: 'user', content: 'List the files in the workspace root and summarise what this project does.' },
    ],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    stream: false,
    temperature: 0.2,
    max_tokens: 8192,
  })
  def({
    id: 'req-40-tools-nonstream',
    title: 'Real DSH 40-tool request (tools verbatim from a logged qwen request/header) + non-stream response',
    provenance: 'derived',
    tags: ['req:40-tools', 'res:nonstream'],
    notes:
      'tools[] is the verbatim 40-tool array from fixtures/derived/dsh-qwen-40-tools.header.json (real DSH session f1376d54, provider qwen, model qwen3.8-max — see fixtures/derived/PROVENANCE.md). The messages array around it is synthetic: real request BODIES are not logged by DSH and require the V0a tap. OpenAI wire shape wraps each logged tool as {type:"function",function:{name,description,parameters}}.',
    request: { body },
    response: nonstreamResponse('chatcmpl-obsfixture0001', {}, {
      prompt_tokens: 18211,
      completion_tokens: 96,
      total_tokens: 18307,
      prompt_tokens_details: { cached_tokens: 17408 },
      completion_tokens_details: { reasoning_tokens: 0 },
    }, 'The workspace root holds a pnpm workspace: packages/, fixtures/, tools/ and root config. The project is Observer, a supervisory runtime for AI agents.'),
  })
}

// ---- 2. unknown fields on the request (reasoning_content history) ----------
def({
  id: 'req-reasoning-history',
  title: 'Request whose assistant history carries reasoning_content + unknown top-level x_custom',
  provenance: 'synthetic',
  tags: ['req:unknown-fields', 'req:reasoning-history', 'res:nonstream'],
  notes:
    'V1/A2 sin (i) material: reasoning_content is ABSENT from OpenAI\'s own ChoiceDelta/ChatCompletionMessage schema (protocol-fidelity.md §4A.1), so any typed parse of this request deletes 100% of the reasoning history. x_custom is a pure unknown-field canary.',
  request: {
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_SHORT },
        { role: 'user', content: 'Where does the rig store its fixtures?' },
        {
          role: 'assistant',
          content: 'Under fixtures/corpus/, one directory per fixture, pinned by manifest.json.',
          reasoning_content: 'The user asked about fixture storage. I inspected the repository layout before answering.',
        },
        { role: 'user', content: 'And how are the hashes verified?' },
      ],
      stream: false,
      temperature: 0.7,
      x_custom: { nested: { deep: true }, flag: '' },
    }),
  },
  response: nonstreamResponse('chatcmpl-obsfixture0002', {
    reasoning_content: 'A short non-streamed reasoning trace that must also survive verbatim.',
  }, USAGE_SMALL, 'The loader re-verifies every sha256 at load time.'),
})

// ---- 3. empty fields that must NOT be dropped ------------------------------
def({
  id: 'req-empty-fields',
  title: 'Request with reasoning_content:"", content:null, tool_calls-shaped empties, stop:[]',
  provenance: 'synthetic',
  tags: ['req:empty-fields', 'res:nonstream'],
  notes:
    'V1/A2 sin (ii) material: some dialects REQUIRE reasoning_content:"" on assistant messages (requiresReasoningContentOnAssistantMessages, §4A.4); an "empty values are noise" serializer changes the request. Empty tool-result content is also realistic (a command with no output).',
  request: {
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_SHORT },
        { role: 'user', content: 'Run the workspace tests.' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: '',
          tool_calls: [
            {
              index: 0,
              id: 'call_obs_2001',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"pnpm -r test","description":"run all workspace tests"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_obs_2001', name: 'bash', content: '' },
      ],
      stream: false,
      stop: [],
      temperature: 0,
    }),
  },
  response: nonstreamResponse('chatcmpl-obsfixture0003', {}, USAGE_SMALL, 'All tests passed.'),
})

// ---- 4. number formatting that JSON round-trips destroy --------------------
def({
  id: 'req-number-formats',
  title: 'Request with 1.0 / 0.900 / 0.0 / 1e3 / 2048.0 number spellings (raw bytes, hand-written)',
  provenance: 'synthetic',
  tags: ['req:number-formats', 'res:nonstream'],
  notes:
    'V1/A2 sin (iii) material: JSON.parse→JSON.stringify rewrites 1.0→1, 0.900→0.9, 1e3→1000. The body is a hand-written template, NOT JSON.stringify output, because the spellings are the point.',
  request: {
    body:
      '{"model":"qwen3.8-max","messages":[{"role":"system","content":"' + SYSTEM_SHORT + '"},{"role":"user","content":"Number formatting must survive byte-exactly."}],"stream":false,"temperature":1.0,"top_p":0.900,"presence_penalty":0.0,"frequency_penalty":0.00,"max_tokens":1e3,"max_completion_tokens":2048.0,"seed":42,"n":1,"logit_bias":{"50256":-100}}',
  },
  response: nonstreamResponse('chatcmpl-obsfixture0004'),
})

// ---- 5. unicode escapes vs literal UTF-8 ------------------------------------
def({
  id: 'req-unicode-escapes',
  title: 'Request mixing \\uXXXX escapes, surrogate pairs, \\/ escapes and literal UTF-8',
  provenance: 'synthetic',
  tags: ['req:unicode-escapes', 'res:nonstream'],
  notes:
    'JSON.parse decodes \\u00e9 to é and JSON.stringify emits it unescaped — a round-trip silently rewrites bytes while "preserving meaning". Byte identity does not care about meaning. Hand-written template on purpose.',
  request: {
    body:
      '{"model":"qwen3.8-max","messages":[{"role":"system","content":"Escaped: caf\\u00e9 \\u4e2d\\u6587 \\ud83d\\ude00 \\u0041\\u0042\\u0043. Literal: café 中文 😀. Both forms must survive byte-exactly."},{"role":"user","content":"Quote \\" backslash \\\\ slash \\/ tab \\t must survive too."}],"stream":false,"temperature":0.3}',
  },
  response: nonstreamResponse('chatcmpl-obsfixture0005'),
})

// ---- 6. generated >5 MB request body ----------------------------------------
def({
  id: 'req-big-5mb',
  title: 'Generated >5 MiB request body (seeded, sha-pinned in the manifest)',
  provenance: 'generated',
  tags: ['req:body-over-5mb', 'res:nonstream'],
  notes:
    'Acceptance criterion "request body >5 MB" without putting 5 MB in git: a deterministic seeded generator (packages/rig/src/generators.ts) produces the body; manifest.json pins its sha256+length, so every load — local and CI, x64 and arm — verifies identical bytes. Bodies at 1M-token context exceed 10 MB; this fixture is the rig-side proof that the pipeline stays streaming at size.',
  request: { generate: { kind: 'big-chat-body', seed: 42, targetBytes: 5 * 1024 * 1024 } },
  response: nonstreamResponse('chatcmpl-obsfixture0006', {}, {
    prompt_tokens: 1438201,
    completion_tokens: 48,
    total_tokens: 1438249,
    prompt_tokens_details: { cached_tokens: 1350656 },
    completion_tokens_details: { reasoning_tokens: 0 },
  }, 'Large-context fixture acknowledged.'),
})

// ---- 7. stream_options.include_usage request + usage-bearing stream ---------
def({
  id: 'req-stream-options',
  title: 'stream:true + stream_options.include_usage:true; usage null until the final chunk',
  provenance: 'synthetic',
  tags: ['req:stream-options', 'res:stream-usage', 'res:stream-done', 'sse'],
  notes:
    '§4.1: usage is present-but-null on every chunk except the last, and the last chunk has choices:[] — the shapes V5 must tolerate. Observer must never ADD stream_options to a client request (that would change the chunk sequence).',
  request: {
    stream: true,
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_SHORT },
        { role: 'user', content: 'Explain what the fidelity rig measures.' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 2048,
    }),
  },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0007', {}, { usage: null })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0007', { content: 'The rig measures ' }, { usage: null })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0007', { content: 'byte identity, ' }, { usage: null })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0007', { content: 'arrival boundaries ' }, { usage: null })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0007', { content: 'and inter-chunk gaps.' }, { usage: null })), delayMs: 30 },
      { payload: sse(finish('chatcmpl-obsfixture0007', 'stop', { usage: null })), delayMs: 30 },
      {
        payload: sse(chunk('chatcmpl-obsfixture0007', [], {
          usage: {
            prompt_tokens: 63,
            completion_tokens: 14,
            total_tokens: 77,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        })),
        delayMs: 30,
      },
      { payload: DONE, delayMs: 30 },
    ],
  },
})

// ---- 8. very large system prompt --------------------------------------------
{
  const rnd = mulberry32(7)
  const words = 'agent byte cache chunk context cursor delta evidence fixture frame gateway hash ledger manifest offset parser payload prefix prompt provider proxy queue record schema segment sequence session socket stream supervisor symbol threshold timeline token transcript'.split(' ')
  const parts = []
  let n = 0
  while (n < 200_000) {
    const w = (k) => words[Math.floor(rnd() * words.length) % words.length] + (k !== undefined ? `_${k}` : '')
    const para = `Rule ${w(n)}: the ${w()} must remain ${w()} while every ${w()} ${w()}s exactly once; consult section ${Math.floor(rnd() * 9000) + 1000} of the ${w()} handbook before touching a ${w()} boundary. `
      .repeat(4)
    parts.push(para)
    n += para.length
  }
  const systemText = `You are operating under the following synthetic operating contract (${parts.length} clauses).\n\n` + parts.join('\n\n')
  def({
    id: 'req-long-system',
    title: '~200 KB system prompt (deterministic), non-stream response',
    provenance: 'synthetic',
    tags: ['req:large-system', 'res:nonstream'],
    notes: 'Large-request mechanics without the full 5 MB fixture: hashing and piping must stay incremental at this size too.',
    request: {
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: 'Acknowledge the operating contract in one sentence.' },
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: 256,
      }),
    },
    response: nonstreamResponse('chatcmpl-obsfixture0008', {}, {
      prompt_tokens: 51244,
      completion_tokens: 12,
      total_tokens: 51256,
      prompt_tokens_details: { cached_tokens: 50176 },
      completion_tokens_details: { reasoning_tokens: 0 },
    }, 'Operating contract acknowledged.'),
  })
}

// ---- 9. grouped tool results -------------------------------------------------
def({
  id: 'req-tool-results',
  title: 'Two parallel tool calls followed by grouped role:tool results',
  provenance: 'synthetic',
  tags: ['req:tool-results', 'res:nonstream'],
  notes:
    'DSH\'s OpenAI path groups consecutive tool results (openai-completions.js:1078); wire messages do not map 1:1 to logical turns (V3 constraint). name is included on tool messages (requiresToolResultName dialects).',
  request: {
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_SHORT },
        { role: 'user', content: 'Check the test status and read the settings file.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { index: 0, id: 'call_obs_1001', type: 'function', function: { name: 'bash', arguments: '{"command":"pnpm -r test","description":"run the workspace tests"}' } },
            { index: 1, id: 'call_obs_1002', type: 'function', function: { name: 'read', arguments: '{"file_path":"config/settings.json"}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_obs_1001',
          name: 'bash',
          content: 'packages/rig test: Done\npackages/gateway test: Done\nAll 2 packages passed.',
        },
        { role: 'tool', tool_call_id: 'call_obs_1002', name: 'read', content: '{\n  "mode": "observe-only",\n  "mutation": false\n}' },
      ],
      stream: false,
      temperature: 0.2,
      max_tokens: 1024,
    }),
  },
  response: nonstreamResponse('chatcmpl-obsfixture0009', {}, USAGE_SMALL, 'Tests pass and the settings file is observe-only.'),
})

// ---- 10. identity-bearing fields ---------------------------------------------
def({
  id: 'req-identity-fields',
  title: 'Request carrying user / prompt_cache_key / safety_identifier (V6 declared-ID sources)',
  provenance: 'synthetic',
  tags: ['req:identity-fields', 'res:nonstream'],
  notes: 'V6 resolves session identity declared-first from exactly these fields; they must survive pass-through byte-identically.',
  request: {
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_SHORT },
        { role: 'user', content: 'Identify this session.' },
      ],
      stream: false,
      user: 'user-fixture-0001',
      prompt_cache_key: 'pk-obs-fixture-session-0001',
      safety_identifier: 'sid-obs-fixture-0001',
    }),
  },
  response: nonstreamResponse('chatcmpl-obsfixture0010'),
})

// ---- 11. canonical non-streaming response ------------------------------------
def({
  id: 'res-nonstream-json',
  title: 'Canonical non-streaming chat.completion with usage + cached_tokens',
  provenance: 'synthetic',
  tags: ['res:nonstream'],
  notes: 'The plainest success path: content-length framing, single write, rich usage block.',
  request: { body: simpleRequest('Return a short non-streaming completion.') },
  response: nonstreamResponse('chatcmpl-obsfixture0011', {
    reasoning_content: 'Non-streamed reasoning traces exist on this dialect too and are equally unprotected.',
  }),
})

// ---- 12. [DONE]-terminated stream ---------------------------------------------
def({
  id: 'res-stream-done',
  title: 'Plain SSE content stream terminated by exactly one data: [DONE]',
  provenance: 'synthetic',
  tags: ['res:stream-done', 'sse'],
  notes: '[DONE] is not JSON (§4.3) — it must be forwarded exactly once and never parsed. The rig asserts byte identity, which subsumes both.',
  request: { stream: true, body: simpleRequest('Stream a short sentence.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0012')), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0012', { content: 'The ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0012', { content: 'quick ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0012', { content: 'brown ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0012', { content: 'fox.' })), delayMs: 30 },
      { payload: sse(finish('chatcmpl-obsfixture0012', 'stop')), delayMs: 30 },
      { payload: DONE, delayMs: 30 },
    ],
  },
})

// ---- 12b. TTFB statistical probe (V4b harness) ------------------------------------------
def({
  id: 'res-stream-ttfb-probe',
  title: 'Short 4-write stream — the V4b triple/quad-arm TTFB harness probe',
  provenance: 'synthetic',
  tags: ['res:stream-ttfb-probe', 'res:stream-done', 'sse'],
  notes:
    'Purpose-built for the V4b statistical TTFB harness (packages/gateway/bench/v4b-timing.mjs): a minimal complete SSE stream with short cadence so 400+ interleaved arm-pairs run in minutes. Timing mode "boundaries": structure is asserted; gap timing is the harness\'s job at statistic scale, not per-run here.',
  timing: { mode: 'boundaries' },
  request: { stream: true, body: simpleRequest('TTFB probe.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0031')), delayMs: 10 },
      { payload: sse(delta('chatcmpl-obsfixture0031', { content: 'probe' })), delayMs: 10 },
      { payload: sse(finish('chatcmpl-obsfixture0031', 'stop')), delayMs: 10 },
      { payload: DONE, delayMs: 10 },
    ],
  },
})

// ---- 13. reasoning_content stream ----------------------------------------------
def({
  id: 'res-stream-reasoning',
  title: 'SSE stream carrying delta.reasoning_content fragments (field absent from OpenAI schema)',
  provenance: 'synthetic',
  tags: ['res:stream-reasoning-content', 'res:stream-done', 'sse'],
  notes:
    'THE fixture for §4A.1: reasoning arrives on delta.reasoning_content, which OpenAI\'s own ChoiceDelta schema does not declare. A typed parse deletes every one of these fragments silently — on qwen there is no provider-side alarm for that loss (§4A.2, regime A).',
  request: { stream: true, body: simpleRequest('Think first, then answer briefly.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0013', { reasoning_content: '' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0013', { reasoning_content: 'Let me ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0013', { reasoning_content: 'inspect the ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0013', { reasoning_content: 'fixture corpus ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0013', { reasoning_content: 'before answering.' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0013', { content: 'The corpus ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0013', { content: 'lives under ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0013', { content: 'fixtures/corpus/.' })), delayMs: 30 },
      { payload: sse(finish('chatcmpl-obsfixture0013', 'stop')), delayMs: 30 },
      { payload: DONE, delayMs: 30 },
    ],
  },
})

// ---- 14. parallel tool calls, interleaved by index ------------------------------
def({
  id: 'res-stream-parallel-tools',
  title: 'SSE stream with two parallel tool calls interleaved by (choice_index, tool_calls_index)',
  provenance: 'synthetic',
  tags: ['res:stream-parallel-tools', 'res:stream-done', 'sse'],
  notes:
    '§4.2: correlation is by index; id appears on the first fragment per index; arguments arrive as raw string fragments; interleaving is legal; there is NO per-tool-call boundary before finish_reason:tool_calls.',
  request: { stream: true, body: simpleRequest('Run the tests and read the config in parallel.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0014')), delayMs: 30 },
      {
        payload: sse(delta('chatcmpl-obsfixture0014', {
          tool_calls: [{ index: 0, id: 'call_obs_0001', type: 'function', function: { name: 'bash', arguments: '' } }],
        })),
        delayMs: 30,
      },
      {
        payload: sse(delta('chatcmpl-obsfixture0014', {
          tool_calls: [{ index: 1, id: 'call_obs_0002', type: 'function', function: { name: 'read', arguments: '' } }],
        })),
        delayMs: 30,
      },
      { payload: sse(delta('chatcmpl-obsfixture0014', { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0014', { tool_calls: [{ index: 1, function: { arguments: '{"file_path":' } }] })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0014', { tool_calls: [{ index: 0, function: { arguments: '"pnpm -r test"}' } }] })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0014', { tool_calls: [{ index: 1, function: { arguments: '"config/settings.json"}' } }] })), delayMs: 30 },
      { payload: sse(finish('chatcmpl-obsfixture0014', 'tool_calls')), delayMs: 30 },
      { payload: DONE, delayMs: 30 },
    ],
  },
})

// ---- 15. obfuscation field on every chunk ----------------------------------------
def({
  id: 'res-stream-obfuscation',
  title: 'SSE stream where every chunk carries the obfuscation padding field',
  provenance: 'synthetic',
  tags: ['res:stream-obfuscation', 'res:stream-done', 'sse'],
  notes:
    '§4.1: obfuscation exists ONLY to be byte-present and sized (side-channel mitigation). Dropping it is invisible to every semantic test — which is exactly why V4c names it a regression test and why the rig compares bytes, not events.',
  request: { stream: true, body: simpleRequest('Stream with obfuscation padding.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0015', {}, { obfuscation: obf(0) })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0015', { content: 'Padded ' }, { obfuscation: obf(1) })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0015', { content: 'chunks ' }, { obfuscation: obf(2) })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0015', { content: 'stay padded.' }, { obfuscation: obf(3) })), delayMs: 30 },
      { payload: sse(finish('chatcmpl-obsfixture0015', 'stop', { obfuscation: obf(4) })), delayMs: 30 },
      { payload: DONE, delayMs: 30 },
    ],
  },
})

// ---- 16. SSE events split across TCP writes AND chunked frames ----------------------
{
  const c = 'chatcmpl-obsfixture0016'
  const A = sse(roleChunk(c))
  const B = sse(delta(c, { content: 'Split ' }))
  const C = sse(delta(c, { content: 'across ' }))
  const D = sse(delta(c, { content: 'frames and writes.' }))
  const E = sse(finish(c, 'stop'))
  const dCut = Math.floor(D.length / 3)
  def({
    id: 'res-stream-split-writes',
    title: 'SSE event split mid-frame across TCP writes; another event spanning two chunked frames',
    provenance: 'synthetic',
    tags: ['res:stream-split-writes', 'res:stream-done', 'sse'],
    notes:
      'V4c criterion: an event split across TCP writes AND across Transfer-Encoding: chunked boundaries. Write 1 splits event B mid-JSON within one frame (splitAfterBytes); write 2 carries all of C plus the head of D, write 3 carries D\'s tail — so D spans two chunked frames.',
    request: { stream: true, body: simpleRequest('Stream content that will be split at awkward boundaries.', { stream: true }) },
    response: {
      status: 200,
      reason: 'OK',
      headers: sseResHeaders(),
      framing: 'chunked',
      writes: [
        { payload: A, delayMs: 30 },
        { payload: B, delayMs: 30, splitAfterBytes: Math.floor(B.length / 2) },
        { payload: C + D.slice(0, dCut), delayMs: 30 },
        { payload: D.slice(dCut), delayMs: 30 },
        { payload: E, delayMs: 30 },
        { payload: DONE, delayMs: 30 },
      ],
    },
  })
}

// ---- 17. strict 50 ms timing ---------------------------------------------------------
def({
  id: 'res-stream-50ms-timing',
  title: 'Eight writes at exactly 50 ms — the V4b incremental-delivery acceptance shape',
  provenance: 'synthetic',
  tags: ['res:stream-timing-strict', 'res:stream-done', 'sse'],
  notes:
    'V4b: "Mock upstream emits one event per TCP write at 50 ms intervals; the client must observe the same intervals within ±5 ms." Deadline-corrected upstream scheduling; the rig checks gaps vs the baseline run AND vs this nominal schedule.',
  timing: { mode: 'strict', gapToleranceMs: 5 },
  request: { stream: true, body: simpleRequest('Stream at a strict cadence.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0017')), delayMs: 50 },
      { payload: sse(delta('chatcmpl-obsfixture0017', { content: 'Timing ' })), delayMs: 50 },
      { payload: sse(delta('chatcmpl-obsfixture0017', { content: 'fidelity ' })), delayMs: 50 },
      { payload: sse(delta('chatcmpl-obsfixture0017', { content: 'is ' })), delayMs: 50 },
      { payload: sse(delta('chatcmpl-obsfixture0017', { content: 'the ' })), delayMs: 50 },
      { payload: sse(delta('chatcmpl-obsfixture0017', { content: 'point.' })), delayMs: 50 },
      { payload: sse(finish('chatcmpl-obsfixture0017', 'stop')), delayMs: 50 },
      { payload: DONE, delayMs: 50 },
    ],
  },
})

// ---- 17b. boundary preservation at scale ------------------------------------------
{
  const c = 'chatcmpl-obsfixture0030'
  const N = 150
  const writes = [{ payload: sse(roleChunk(c)), delayMs: 5 }]
  for (let i = 0; i < N - 2; i++) {
    writes.push({
      payload: sse(delta(c, { content: `fragment-${String(i).padStart(3, '0')} ` })),
      delayMs: 5,
    })
  }
  writes.push({ payload: sse(finish(c, 'stop')), delayMs: 5 })
  writes.push({ payload: DONE, delayMs: 5 })
  def({
    id: 'res-stream-many-events',
    title: `${writes.length} fast SSE writes — chunk-boundary preservation at scale`,
    provenance: 'synthetic',
    tags: ['res:stream-boundaries-at-scale', 'res:stream-done', 'sse'],
    notes:
      'V4a: boundary identity must hold at event counts where off-by-one coalescing hides. Timing mode is "boundaries": arrival COUNT and per-arrival byte lengths are asserted; inter-arrival gaps are NOT (structure is deterministic, scheduling is noisy — a structural guarantee must not flake on jitter). Delays are 5ms so the whole stream costs <1s per run.',
    timing: { mode: 'boundaries' },
    request: { stream: true, body: simpleRequest('Stream many small fragments.', { stream: true }) },
    response: {
      status: 200,
      reason: 'OK',
      headers: sseResHeaders(),
      framing: 'chunked',
      writes,
    },
  })
}

// ---- 18. empty-string reasoning deltas on every chunk ---------------------------------
def({
  id: 'res-stream-empty-reasoning',
  title: 'SSE stream where chunks carry reasoning_content:"" alongside content',
  provenance: 'synthetic',
  tags: ['res:stream-empty-reasoning', 'res:empty-fields', 'res:stream-done', 'sse'],
  notes: '§4A.4: some dialects emit (or require) reasoning_content:"" on every assistant chunk. An empty-value-dropping serializer deletes these fields and edits the stream.',
  request: { stream: true, body: simpleRequest('Stream with empty reasoning deltas present.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0018', { reasoning_content: '' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0018', { content: 'Empty ', reasoning_content: '' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0018', { content: 'reasoning ', reasoning_content: '' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0018', { content: 'is meaningful.', reasoning_content: '' })), delayMs: 30 },
      { payload: sse(finish('chatcmpl-obsfixture0018', 'stop')), delayMs: 30 },
      { payload: DONE, delayMs: 30 },
    ],
  },
})

// ---- 19. interrupted before finish/usage/[DONE] ----------------------------------------
def({
  id: 'res-stream-interrupted-no-done',
  title: 'Stream dies at a write boundary before finish_reason, usage, or [DONE]',
  provenance: 'synthetic',
  tags: ['res:stream-interrupted', 'sse', 'truncation'],
  notes:
    '§4.1: "If the stream is interrupted or cancelled, you may not receive the final usage chunk." V5 must tolerate absence; every metric degrades to unknown, never to 0. Socket dies AFTER write index 4 (clean frame boundary, then FIN).',
  request: { stream: true, body: simpleRequest('This stream will be interrupted.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0019')), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0019', { content: 'This stream ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0019', { content: 'will not ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0019', { content: 'finish ' })), delayMs: 30 },
      { payload: sse(delta('chatcmpl-obsfixture0019', { content: 'cleanly...' })), delayMs: 30 },
    ],
    terminate: { kind: 'destroy-after-write', writeIndex: 4 },
  },
})

// ---- 20. aborted MID-chunk ---------------------------------------------------------------
{
  const c = 'chatcmpl-obsfixture0020'
  const w = [
    sse(roleChunk(c)),
    sse(delta(c, { content: 'The abort ' })),
    sse(delta(c, { content: 'lands inside this very event payload, mid-JSON.' })),
    sse(delta(c, { content: 'never sent' })),
  ]
  const cutAt = Buffer.byteLength(w[0]) + Buffer.byteLength(w[1]) + 40 // inside w[2], mid-JSON
  def({
    id: 'res-abort-mid-chunk',
    title: 'Socket dies mid-SSE-event: partial chunk delivered, no frame terminator, FIN',
    provenance: 'synthetic',
    tags: ['res:stream-abort-mid-chunk', 'sse', 'truncation'],
    notes:
      'Acceptance criterion "stream aborted mid-chunk". The upstream sends a chunk-size line for bytes that never fully arrive, then the socket dies. The rig asserts the client saw the SAME truncated byte count on both paths — a SUT that completes, pads, or hangs its framing fails. Capture-side, this is the case that must be marked incomplete, never complete.',
    request: { stream: true, body: simpleRequest('This stream aborts mid-chunk.', { stream: true }) },
    response: {
      status: 200,
      reason: 'OK',
      headers: sseResHeaders(),
      framing: 'chunked',
      writes: [
        { payload: w[0], delayMs: 30 },
        { payload: w[1], delayMs: 30 },
        { payload: w[2], delayMs: 30 },
        { payload: w[3], delayMs: 30 },
      ],
      terminate: { kind: 'destroy-after-body-bytes', bodyBytes: cutAt },
    },
  })
}

// ---- 20b. provider error event mid-stream, then socket death -------------------------
def({
  id: 'res-stream-error-payload',
  title: 'Provider error SSE event mid-stream, then socket death (no finish_reason, no [DONE])',
  provenance: 'synthetic',
  tags: ['res:stream-error-payload', 'sse', 'truncation'],
  notes:
    'V4d: providers can deliver errors IN-band as an SSE error event and then kill the connection (protocol-fidelity §4.3: no error event exists in the official schema — dialects invent them). Both the error payload bytes and the truncation must reach the client verbatim, and no capture may call this complete: no terminal event was observed.',
  request: { stream: true, body: simpleRequest('This stream errors mid-flight.', { stream: true }) },
  response: {
    status: 200,
    reason: 'OK',
    headers: sseResHeaders(),
    framing: 'chunked',
    writes: [
      { payload: sse(roleChunk('chatcmpl-obsfixture0032')), delayMs: 20 },
      { payload: sse(delta('chatcmpl-obsfixture0032', { content: 'partial answer...' })), delayMs: 20 },
      {
        payload: sse({
          id: 'chatcmpl-obsfixture0032',
          object: 'chat.completion.chunk',
          created: CREATED,
          model: MODEL,
          error: {
            message: 'Internal server error: inference node lost mid-generation',
            type: 'server_error',
            param: null,
            code: 'internal_error',
          },
        }),
        delayMs: 20,
      },
    ],
    terminate: { kind: 'destroy-after-write', writeIndex: 2 },
  },
})

// ---- 21. 429 with JSON error body + retry-after ------------------------------------------
def({
  id: 'res-429-json',
  title: '429 rate-limit with JSON error body, retry-after and x-ratelimit-* headers',
  provenance: 'synthetic',
  tags: ['res:4xx-json', 'error'],
  notes: 'V1/A5: 429 with retry-after must pass through unchanged — the SDK retry behaviour downstream depends on those exact headers (§3.5: retries are the normal case).',
  request: { body: simpleRequest('This request is rate limited.') },
  response: {
    status: 429,
    reason: 'Too Many Requests',
    headers: jsonResHeaders([
      ['retry-after', '2'],
      ['x-ratelimit-limit-requests', '60'],
      ['x-ratelimit-remaining-requests', '0'],
      ['x-ratelimit-reset-requests', '2s'],
    ]),
    framing: 'length',
    writes: [
      {
        payload: JSON.stringify({
          error: {
            message:
              'Rate limit reached for model qwen3.8-max in organization org-observer-fixture on requests per min (RPM): Limit 60, Used 60, Requested 1. Please try again in 2 seconds.',
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_exceeded',
          },
        }),
        delayMs: 10,
      },
    ],
  },
})

// ---- 22. 400 with JSON error body -------------------------------------------------------------
def({
  id: 'res-400-json-invalid',
  title: '400 invalid_request_error with JSON body',
  provenance: 'synthetic',
  tags: ['res:4xx-json', 'error'],
  notes: 'A provider-side validation failure must arrive byte-identically — Observer must not "improve" error bodies.',
  request: { body: simpleRequest('This request is invalid.') },
  response: {
    status: 400,
    reason: 'Bad Request',
    headers: jsonResHeaders(),
    framing: 'length',
    writes: [
      {
        payload: JSON.stringify({
          error: {
            message: "Invalid value for 'messages': unsupported role 'sentinel'.",
            type: 'invalid_request_error',
            param: 'messages',
            code: null,
          },
        }),
        delayMs: 10,
      },
    ],
  },
})

// ---- 23. 5xx with NON-JSON body -------------------------------------------------------------------
def({
  id: 'res-502-nonjson',
  title: '502 Bad Gateway with an HTML (non-JSON) body',
  provenance: 'synthetic',
  tags: ['res:5xx-nonjson', 'error'],
  notes:
    'Acceptance criterion "a 5xx with NON-JSON body": infrastructure errors are HTML/plain text, and any code path that assumes JSON errors crashes exactly when the provider is already down — violating fail-open (I1).',
  request: { body: simpleRequest('The upstream infrastructure fails.') },
  response: {
    status: 502,
    reason: 'Bad Gateway',
    headers: [['date', DATE], ['content-type', 'text/html'], ['connection', 'close']],
    framing: 'length',
    writes: [
      {
        payload:
          '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n',
        delayMs: 10,
      },
    ],
  },
})

// ---- 24. gzip-encoded response (bytes forwarded as-is) ---------------------------------------------
{
  const json = completion('chatcmpl-obsfixture0024', {}, {
    prompt_tokens: 88,
    completion_tokens: 21,
    total_tokens: 109,
    prompt_tokens_details: { cached_tokens: 64 },
  }, 'A gzip-framed completion body.')
  const gz = gzipSync(utf8(json))
  def({
    id: 'res-gzip-nonstream',
    title: 'content-encoding: gzip response — compressed bytes forwarded untouched',
    provenance: 'synthetic',
    tags: ['res:compression', 'res:nonstream'],
    notes:
      'Spec §8 (resolved): pass compression through untouched; decompress a COPY for observation. Decompress→observe→recompress breaks byte identity (gzip is not byte-stable across settings). The rig never decompresses: it compares the compressed bytes directly. NOTE: the .bin is zlib-version dependent, so --check verifies it by manifest hash, not by re-compression.',
    request: { body: simpleRequest('Return a gzip-encoded completion.') },
    response: {
      status: 200,
      reason: 'OK',
      headers: jsonResHeaders([['content-encoding', 'gzip']]),
      framing: 'length',
      writes: [{ file: 'response.gzip.bin', bytes: gz, gzipOf: json, delayMs: 10 }],
    },
  })
}

// ---- 24b. brotli-encoded response (task-2 criterion names gzip AND br) ---------
{
  const json = completion('chatcmpl-obsfixture0029', {}, {
    prompt_tokens: 91,
    completion_tokens: 18,
    total_tokens: 109,
    prompt_tokens_details: { cached_tokens: 64 },
  }, 'A brotli-framed completion body.')
  const br = brotliCompressSync(utf8(json))
  def({
    id: 'res-br-nonstream',
    title: 'content-encoding: br response — compressed bytes forwarded untouched',
    provenance: 'synthetic',
    tags: ['res:compression', 'res:nonstream'],
    notes:
      'Task-2 acceptance names gzip AND br. Same contract as res-gzip-nonstream: the tap/gateway never decompress on the wire path; the stored bytes are the compressed bytes as received. --check verifies this artifact semantically (brotli-decompressed content equals the builder source) because compressed output is zlib-version dependent.',
    request: { body: simpleRequest('Return a brotli-encoded completion.') },
    response: {
      status: 200,
      reason: 'OK',
      headers: jsonResHeaders([['content-encoding', 'br']]),
      framing: 'length',
      writes: [{ file: 'response.br.bin', bytes: br, brotliOf: json, delayMs: 10 }],
    },
  })
}

// ---- 25. response header fidelity ----------------------------------------------------------------
def({
  id: 'res-headers-passthrough',
  title: 'Response with x-request-id / x-trace-id / ratelimit headers that must pass through in order',
  provenance: 'synthetic',
  tags: ['res:headers', 'res:nonstream'],
  notes: 'V1/A4: no header added, renamed, or reordered; provider x-* headers forwarded unchanged. SloppyHeadersPipe (faulty double) drops exactly these.',
  request: { body: simpleRequest('Return a completion with trace headers.') },
  response: nonstreamResponse(
    'chatcmpl-obsfixture0025',
    {},
    USAGE_SMALL,
    'Headers on this response are part of the contract.',
    10,
    [
      ['x-request-id', 'req_obs_fixture_7f3a91c2'],
      ['x-trace-id', 'trace-obs-9c2e41b7'],
      ['x-ratelimit-remaining-tokens', '98765'],
      ['cache-control', 'no-store'],
    ],
  ),
})

// ---- 26. multi-byte UTF-8 split across TCP writes -------------------------------------------------
{
  const c = 'chatcmpl-obsfixture0026'
  const ev = sse(delta(c, { content: 'Ünïcödé ✓ 中文 🎯 must survive a split inside a multi-byte character.' }))
  const evBuf = utf8(ev)
  const emojiOffset = evBuf.indexOf(Buffer.from('🎯', 'utf8'))
  const splitAt = emojiOffset + 2 // inside the 4-byte emoji: a byte-level split no UTF-8-aware copier survives by luck
  def({
    id: 'res-stream-unicode-split',
    title: 'TCP write boundary lands INSIDE a multi-byte UTF-8 character',
    provenance: 'synthetic',
    tags: ['res:stream-unicode', 'res:stream-split-writes', 'res:stream-done', 'sse'],
    notes:
      'Any implementation that decodes chunks to strings per-arrival corrupts this stream (replacement characters at the split). Byte-forwarding survives by construction; this fixture is the proof.',
    request: { stream: true, body: simpleRequest('Stream multibyte content across a hostile split.', { stream: true }) },
    response: {
      status: 200,
      reason: 'OK',
      headers: sseResHeaders(),
      framing: 'chunked',
      writes: [
        { payload: sse(roleChunk(c)), delayMs: 30 },
        { payload: ev, delayMs: 30, splitAfterBytes: splitAt },
        { payload: sse(finish(c, 'stop')), delayMs: 30 },
        { payload: DONE, delayMs: 30 },
      ],
    },
  })
}

// ---- 27/28. retry pair: identical request bytes, partial then complete response ----------
{
  const retryBody = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_SHORT },
      { role: 'user', content: 'Summarise the last tool result. (This exact request is sent twice: the SDK retries after the first stream dies.)' },
    ],
    stream: true,
    temperature: 0.2,
    max_tokens: 512,
  })
  def({
    id: 'res-stream-retry-partial',
    title: 'Retry pair 1/2: stream dies after three events; SDK will resend identical bytes',
    provenance: 'synthetic',
    tags: ['res:stream-retry-pair', 'res:stream-interrupted', 'sse', 'truncation', 'retry'],
    notes:
      'Lead\'s corpus scan: llm/retry appears 99 times across 73 sessions — retries are the NORMAL case (§3.5). This fixture and res-stream-retry-complete carry byte-IDENTICAL request bodies (the coverage test asserts the sha match) so V5 request de-duplication by body hash has a golden pair from day one.',
    request: { stream: true, body: retryBody, retryCount: '0' },
    response: {
      status: 200,
      reason: 'OK',
      headers: sseResHeaders(),
      framing: 'chunked',
      writes: [
        { payload: sse(roleChunk('chatcmpl-obsretry0A')), delayMs: 30 },
        { payload: sse(delta('chatcmpl-obsretry0A', { content: 'The last tool result ' })), delayMs: 30 },
        { payload: sse(delta('chatcmpl-obsretry0A', { content: 'shows tests passing...' })), delayMs: 30 },
      ],
      terminate: { kind: 'destroy-after-write', writeIndex: 2 },
    },
  })
  def({
    id: 'res-stream-retry-complete',
    title: 'Retry pair 2/2: same request bytes, new completion id, stream finishes with [DONE]',
    provenance: 'synthetic',
    tags: ['res:stream-retry-pair', 'res:stream-done', 'sse', 'retry'],
    notes:
      'The retried request gets a NEW completion id (obsretry0B) but the request body sha256 is identical to res-stream-retry-partial. Response chunks of ONE completion share (id, created) per §4.1 — V5 dedups responses by that pair and requests by body hash.',
    request: { stream: true, body: retryBody, retryCount: '1' },
    response: {
      status: 200,
      reason: 'OK',
      headers: sseResHeaders(),
      framing: 'chunked',
      writes: [
        { payload: sse(roleChunk('chatcmpl-obsretry0B')), delayMs: 30 },
        { payload: sse(delta('chatcmpl-obsretry0B', { content: 'The last tool result ' })), delayMs: 30 },
        { payload: sse(delta('chatcmpl-obsretry0B', { content: 'shows tests passing ' })), delayMs: 30 },
        { payload: sse(delta('chatcmpl-obsretry0B', { content: 'in all packages.' })), delayMs: 30 },
        { payload: sse(finish('chatcmpl-obsretry0B', 'stop')), delayMs: 30 },
        { payload: DONE, delayMs: 30 },
      ],
    },
  })
}

// ---------------------------------------------------------------------------
// Build / check
// ---------------------------------------------------------------------------

const INLINE_LIMIT = 4096 // request bodies above this size go to request.bin

function buildFixture(d) {
  const files = new Map() // relpath (within fixture dir) -> Buffer
  const generated = {} // key -> { spec, sha256, bytes }
  // Files whose bytes are compressed artifacts: gzip/brotli output is
  // zlib-version dependent, so --check verifies them by committed-manifest hash +
  // semantic (decompressed) equality instead of byte-recompression. CI runs a
  // different zlib build than the machine that froze the bytes; the DECOMPRESSED
  // content is the platform-independent contract.
  const zlibDependent = new Map() // relpath -> { kind, source }

  // ---- request body ----
  let bodyBytes
  let bodyRef
  if (typeof d.request.body === 'string') {
    bodyBytes = utf8(d.request.body)
    if (bodyBytes.length <= INLINE_LIMIT) {
      bodyRef = { inline: d.request.body }
    } else {
      bodyRef = { file: 'request.bin' }
      files.set('request.bin', bodyBytes)
    }
  } else if (d.request.generate) {
    bodyRef = { generate: d.request.generate }
    bodyBytes = bigChatBody(d.request.generate)
    generated['request.body'] = { spec: d.request.generate, sha256: sha(bodyBytes), bytes: bodyBytes.length }
  } else {
    throw new Error(`fixture ${d.id}: request must have body string or generate spec`)
  }

  const headers = requestHeaders(bodyBytes.length, {
    stream: d.request.stream ?? false,
    retryCount: d.request.retryCount ?? '0',
  })

  // ---- response writes ----
  const writes = []
  d.response.writes.forEach((w, i) => {
    const entry = { delayMs: w.delayMs }
    if (w.splitAfterBytes !== undefined) entry.splitAfterBytes = w.splitAfterBytes
    if (typeof w.payload === 'string') {
      entry.payload = { inline: w.payload }
    } else if (w.file) {
      entry.payload = { file: w.file }
      files.set(w.file, w.bytes)
      if (w.gzipOf !== undefined) zlibDependent.set(w.file, { kind: 'gzip', source: w.gzipOf })
      if (w.brotliOf !== undefined) zlibDependent.set(w.file, { kind: 'brotli', source: w.brotliOf })
    } else {
      throw new Error(`fixture ${d.id}: write ${i} has neither payload string nor file`)
    }
    writes.push(entry)
  })

  const fixtureJson = {
    id: d.id,
    title: d.title,
    provenance: d.provenance,
    tags: d.tags,
    ...(d.notes ? { notes: d.notes } : {}),
    request: {
      method: 'POST',
      target: '/v1/chat/completions',
      headers,
      body: bodyRef,
    },
    response: {
      status: d.response.status,
      reason: d.response.reason,
      headers: d.response.headers,
      framing: d.response.framing,
      ...(d.response.contentLength !== undefined ? { contentLength: d.response.contentLength } : {}),
      writes,
      ...(d.response.terminate ? { terminate: d.response.terminate } : {}),
    },
    ...(d.timing ? { timing: d.timing } : {}),
  }
  files.set('fixture.json', utf8(`${JSON.stringify(fixtureJson, null, 2)}\n`))

  const manifestFiles = {}
  for (const name of [...files.keys()].sort()) {
    const buf = files.get(name)
    manifestFiles[name] = { sha256: sha(buf), bytes: buf.length }
  }
  return {
    id: d.id,
    files,
    zlibDependent,
    manifestEntry: { id: d.id, dir: d.id, files: manifestFiles, ...(Object.keys(generated).length ? { generated } : {}) },
  }
}

function main() {
  const built = defs.map(buildFixture)
  const manifest = { version: 1, fixtures: built.map((b) => b.manifestEntry) }
  const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`)

  if (CHECK) {
    const problems = []
    const manifestPath = path.join(CORPUS, 'manifest.json')
    if (!existsSync(manifestPath)) {
      console.error('build-fixtures --check: FAILED — manifest.json missing; run: node tools/build-fixtures.mjs')
      process.exit(1)
    }
    const committedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const rebuiltManifest = { version: 1, fixtures: built.map((b) => b.manifestEntry) }

    for (const b of built) {
      const committedEntry = committedManifest.fixtures.find((f) => f.id === b.id)
      if (!committedEntry) {
        problems.push(`MISSING manifest entry for ${b.id}`)
        continue
      }
      for (const [rel, expected] of b.files) {
        const p = path.join(CORPUS, b.id, rel)
        if (!existsSync(p)) {
          problems.push(`MISSING ${b.id}/${rel}`)
          continue
        }
        const onDisk = readFileSync(p)
        // (1) Integrity: disk bytes must match the COMMITTED manifest (this is the
        //     same contract the rig loader enforces at test time).
        const cm = committedEntry.files?.[rel]
        if (!cm) {
          problems.push(`MANIFEST-ENTRY MISSING ${b.id}/${rel}`)
        } else if (sha(onDisk) !== cm.sha256 || onDisk.length !== cm.bytes) {
          problems.push(`HASH ${b.id}/${rel}: disk ${sha(onDisk)} != committed manifest ${cm.sha256}`)
        }
        // (2) Builder drift: deterministic files must equal a fresh rebuild.
        //     zlib-dependent files are exempt from byte comparison (their bytes are
        //     frozen artifacts of the machine that built them) and get the semantic
        //     check in (3) instead.
        const zdep = b.zlibDependent.get(rel)
        if (zdep === undefined && !onDisk.equals(expected)) {
          problems.push(`DIFFERS ${b.id}/${rel}`)
        }
        // (3) Semantic check for compressed artifacts: decompressed content must
        //     equal the builder's source — platform-independent, unlike the
        //     compressed bytes.
        if (zdep !== undefined) {
          let decompressed
          try {
            decompressed = zdep.kind === 'gzip' ? gunzipSync(onDisk) : brotliDecompressSync(onDisk)
          } catch (err) {
            problems.push(`DECOMPRESS ${b.id}/${rel} (${zdep.kind}): ${err.message}`)
            decompressed = undefined
          }
          if (decompressed && decompressed.toString('utf8') !== zdep.source) {
            problems.push(`COMPRESSED-CONTENT ${b.id}/${rel}: decompressed bytes != builder source`)
          }
          // The rebuilt manifest must carry the COMMITTED hash for this file (the
          // recompressed bytes are allowed to differ across zlib versions).
          const target = rebuiltManifest.fixtures.find((f) => f.id === b.id)
          if (target && cm) target.files[rel] = cm
        }
      }
      // (4) Generated payloads: re-run the generator, compare to the COMMITTED pins
      //     (cross-platform determinism check — the rig loader does the same at test time).
      for (const [key, g] of Object.entries(committedEntry.generated ?? {})) {
        const out = bigChatBody(g.spec)
        if (sha(out) !== g.sha256 || out.length !== g.bytes) {
          problems.push(`GENERATOR ${b.id}/${key}: output sha/bytes != committed manifest pins`)
        }
      }
      // (5) Stale files on disk that this build would not produce
      const dir = path.join(CORPUS, b.id)
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (!b.files.has(name)) problems.push(`STALE ${b.id}/${name}`)
        }
      }
    }
    // (6) manifest.json as a whole (with zlib entries normalized to committed values)
    const expectedManifestBytes = utf8(`${JSON.stringify(rebuiltManifest, null, 2)}\n`)
    if (!readFileSync(manifestPath).equals(expectedManifestBytes)) problems.push('DIFFERS manifest.json')
    if (existsSync(CORPUS)) {
      const known = new Set(defs.map((d) => d.id).concat(['manifest.json']))
      for (const name of readdirSync(CORPUS)) {
        if (!known.has(name)) problems.push(`STALE corpus/${name}`)
      }
    }
    if (problems.length) {
      console.error(`build-fixtures --check: FAILED (${problems.length} problem(s)) — corpus drifted from tools/build-fixtures.mjs:`)
      for (const p of problems) console.error(`  ${p}`)
      console.error('Rebuild deliberately: node tools/build-fixtures.mjs')
      process.exit(1)
    }
    console.log(`build-fixtures --check: ok — ${built.length} fixtures match the builder; committed hashes verified.`)
    return
  }

  // Full rebuild: wipe the corpus dir and rewrite from the definitions.
  if (existsSync(CORPUS)) {
    rmSync(CORPUS, { recursive: true, force: true })
  }
  mkdirSync(CORPUS, { recursive: true })
  for (const b of built) {
    const dir = path.join(CORPUS, b.id)
    mkdirSync(dir, { recursive: true })
    for (const [rel, buf] of b.files) writeFileSync(path.join(dir, rel), buf)
  }
  writeFileSync(path.join(CORPUS, 'manifest.json'), manifestBytes)
  const totalBytes = built.reduce((n, b) => {
    let s = 0
    for (const buf of b.files.values()) s += buf.length
    for (const g of Object.values(b.manifestEntry.generated ?? {})) s += g.bytes
    return n + s
  }, 0)
  console.log(`build-fixtures: wrote ${built.length} fixtures to fixtures/corpus/ (${(totalBytes / 1024).toFixed(1)} KiB on disk + generated payloads).`)
}

main()
