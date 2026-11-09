# Vertical Slice — Task Breakdown (v1)

**Author:** `aura` · **Date:** 2026-11-09 · **Status:** proposed, for `lead` to file on the board
**Answers:** T10(ii), round 2 — retargeted to **OpenAI Chat Completions** per lead's T10 correction.
**Evidence base:** `docs/research/protocol-fidelity.md` (§ refs below), `docs/recon/dsh-session-format.md`,
`docs/recon/dsh-compaction-prior-art.md`.

---

## 0. What the slice proves

> A gateway can terminate a live OpenAI Chat Completions request from DeepSeek Harness (qwen
> provider), normalise it, record it, forward it upstream **unmodified**, stream the response back
> **byte-faithfully**, and render the session in a dashboard. No mutation, no injection, no judge,
> no compaction, no cleaning.

The point is not the feature. It is the proof that **standing in the middle breaks nothing** — which
is a stronger claim than it looks, because the naive implementation breaks it in ways that are
invisible until an agent misbehaves (§2, V1/A2).

Per P3 the slice is observe-only, and per P4 it contains **no model calls from Observer**. Those two
decisions make this slice unusually safe, and they are load-bearing: everything dangerous in
Observer sits behind this gate.

### Retargeting consequence (read this before the task list)

Round 1 assumed Anthropic Messages first. DSH on this machine speaks **OpenAI Chat Completions to a
qwen provider** (`tools[].parameters`, `provider: "qwen"`, `model: "qwen3.8-max"`,
`contextWindow: 1000000` — recon §3). That changes the risk profile in both directions:

| | Easier than Anthropic | Harder than Anthropic |
|---|---|---|
| **Why** | No thinking-block `signature`, no prefix check, no 400-on-edit, no `ping` semantics to synthesise | No per-tool-call boundary before `finish_reason` (§4.2); reasoning arrives on a **non-standard field absent from OpenAI's own schema** (§4A.1); `obfuscation` field exists purely to be byte-present (§4.1); ≥51 provider dialects with 25 compat flags (§4A.4); no keepalive event |

**The single most important retargeting fact:** a prefix edit on qwen does **not** produce a 400 or
a drop-cascade — reasoning there is unprotected plain text (§4A.2, regime A). So the round-1 warning
that *"the pass-through gateway is itself a prefix edit if the serializer drops unknown block types,
drops empty fields, or reorders blocks"* still applies, but **its failure mode on target one is
silent**: cache loss plus undetectable reasoning corruption, with no provider-side alarm. That is
why V1's acceptance criteria are byte-identity tests rather than "does it error".

### Empirical update that reorders V8 (2026-11-09)

`docs/research/noise-drift-study.md` reports the drift-vs-noise study proposed in T15 Q4, over the
73-session corpus. Verdict: **no temporal lead–lag in either direction**; the raw "drift-leads" tilt
is a measurement artefact reproduced by a zero-lead null simulation (33:0 vs the observed 14:1).
What the data does establish is **synchrony with a shared origin** — 98.9% of redundant bytes come
from exact-duplicate tool calls, and **84% of all duplicate events in the corpus come from a single
2.9-hour thrashing loop (891 byte-identical `sed` calls)**. The same event is counted by both the
drift proxy and the noise proxy, so the series move together at lag 0 by construction.

Consequences for this slice, and I want them stated rather than buried:

- **My T15 Q4 prediction was directionally right and mechanistically wrong.** I predicted
  *drift leads ρ*; the study finds no lead at all, and instead finds that thrashing episodes *are*
  the noise. The conclusion I drew — do not build a prefix-cleaning writer as drift prevention — is
  supported, but by **event-level identity**, not by a time lag. The circularity warning in Q4
  ("drift metric must be defined independently of ρ") turned out to be the crux, and the study's
  increment-space and component-decomposition passes are what removed it.
- **A context cleaner has no empirical support as a drift-prevention device.** Any future proposal
  to build one must argue it on a different basis (context-size pressure, cost, or the Human's
  signal-to-noise objection in T15) and must not cite drift reduction.
- **The loop detector is the product; ρ is a diagnostic.** A trivial deterministic
  `(name, normalised-args)` repeat counter would have flagged that 891-iteration loop within ~5–20
  iterations; it then ran ~870 more times over 2.9 hours. That is the single highest-value
  observation in the whole corpus, and it is nearly free to compute. V8's ordering below reflects
  this.
- **ρ is dominated by one outlier session** and is therefore a poor prioritisation signal at corpus
  scale. Report it per session with its components; do not aggregate it into a single number and
  certainly do not trigger on a corpus-level ρ.


---

## 1. Package boundaries for the slice

Round-1 `core` split, kept, with **one addition** (`capture/`) and the round-1 corrections applied.

```
packages/
  transcript/    normalised types + adapter target shapes. Depends on NOTHING.
                 Everything imports it; it imports nothing. (5 change rates → this is the slowest.)
  capture/       NEW. Byte-level pipeline: raw req/res in and out, incremental hashing, timings,
                 spool-to-store. Owns the byte-fidelity guarantee.
  store/         dumb append(bytes)→id / read(id)→bytes / list(session). NO integrity logic.
  ledger/        append-only hashed evidence ledger. OWNS the hash chain.
  detectors/     pure (Session) => Signal[]. One file per detector, no shared state.
  policy/        (Signal, Policy) => Action. Pure, no I/O. Hard-wired to `observe` in this slice.
  gateway/       HTTP proxy + adapters/openai-chat/{request,response,stream}.
apps/
  observer/      CLI + daemon: run, attach, status.
  dashboard/     read-only app over store. NOT a package (round-1 correction).
```

**Why `capture/` is separate from `gateway/`.** Byte fidelity is the slice's entire claim, and it is
untestable if it lives inside an HTTP server. Isolating "bytes in → hash → spool → bytes out" as a
pure-ish pipeline lets V1's acceptance criteria be unit-tested against fixtures with no socket
involved. This is the one place I am adding structure beyond my round-1 answer, and it is because
V4's risk (§3) is high enough to deserve its own testable unit.

**Why `store/` owns no integrity** (round-1 correction, restated because it will be got wrong):
two components that both "guarantee" append-only-hashed produce a guarantee nobody tests. `ledger/`
owns the hash chain; `store/` is a byte sink. Enforce with a dependency-boundary test, not a
convention.

**Not built in this slice:** `watcher/` (round 1: P2 says DSH first and the gateway covers DSH; a
one-parser package for an interceptable agent is pure cost, and DSH's log format is versioned and
mutates — `session-format-v0…v4`). No `compaction/`, no `injection/`, no `judge/`.

---

## 2. Task breakdown

Spine tasks are **strictly sequential**; `[P]` marks parallelisable once deps are met.
Estimates are deliberately omitted — see §3 for where any estimate will be wrong.

---

### V0 — Workspace, fidelity rig, and fixture corpus
**Deps:** none · **Parallel:** no — **spine start, everything waits on this**
**Scope:** pnpm workspace, TS/Node 26 config, vitest, CI; the **differential fidelity harness**; a
recorded fixture corpus of real DSH→qwen traffic.

The rig sends each captured request (a) direct to a mock upstream and (b) via Observer, then diffs
status + headers + **body bytes with offsets**. It must run with zero network.

**Acceptance criteria**
- [ ] `pnpm -r build && pnpm -r test` green in CI on a clean checkout.
- [ ] Rig reports byte-level diffs with offsets and lengths, not "bodies differ".
- [ ] Rig asserts **incremental arrival** (inter-chunk gaps), not just final bytes.
- [ ] ≥20 fixtures covering, at minimum: a 40-tool request; a streaming response carrying
      `reasoning_content`; a streaming response with ≥2 parallel tool calls; a non-streaming
      response; a 4xx with a JSON error body; a 5xx with a **non-JSON** body; a response whose chunks
      carry `obfuscation`; a request body >5 MB; a stream aborted mid-chunk; a `[DONE]`-terminated
      stream.
- [ ] **Blocking unknown resolved:** confirm whether DSH's session log contains full request
      *bodies*. Recon shows `request/header` (config + tools) and `request/context`
      (provider/model/contextWindow) — **not** obviously the message array. If bodies are not
      logged, fixture capture requires a logging tap first, which becomes task V0a and gates
      everything. Resolve this on day 1, not day 5.
- [ ] **Blocking unknown resolved:** confirm whether DSH can be configured to send a custom header
      (gates V6). See V6.

**Underestimated because:** everyone assumes fixtures are free. They are the deliverable that makes
every later acceptance criterion meaningful, and real qwen traffic at 1M-token context produces
multi-megabyte bodies that are awkward to store in a repo. Budget for a fixture store outside git
plus a checked-in subset.

---

### V1 — Byte-faithful pass-through, non-streaming ⚠️ *the prefix-edit gate lives here*
**Deps:** V0 · **Parallel:** no — **spine**
**Scope:** `gateway/` HTTP server (`POST /v1/chat/completions`; `/v1/responses` returns an explicit
`501 unsupported-protocol`), request/response forwarding, header filtering, `capture/` hookup.

**Acceptance criteria**
- [ ] **A1 — upstream body byte-identity.** Bytes sent upstream are `sha256`-identical to bytes
      received from the client. **No `JSON.parse` → `JSON.stringify` anywhere on this path.**
      Verified on every fixture by the rig.
- [ ] **A2 — the three serializer sins are named regression tests.** Each must fail loudly if anyone
      introduces a typed round-trip:
      1. **unknown fields dropped** — a request carrying `reasoning_content` on an assistant
         message and a bogus `x_custom` key survives byte-identically. This is the one that silently
         deletes *all* reasoning on target one, because `reasoning_content` is absent from OpenAI's
         own `ChoiceDelta` schema (§4A.1).
      2. **empty fields dropped** — `"reasoning_content": ""`, `"tool_calls": []`, `"content": null`
         survive. Some dialects *require* `reasoning_content: ""`
         (`requiresReasoningContentOnAssistantMessages`, §4A.4); dropping it changes the request.
      3. **key order / number formatting changed** — byte-identical, including `1.0` vs `1`.
- [ ] **A3 — response byte-identity** to the client for non-streaming: status, `content-type`, body.
- [ ] **A4 — header hygiene.** Hop-by-hop headers stripped (`connection`, `keep-alive`,
      `transfer-encoding`, `upgrade`, `proxy-*`, `te`, `trailer`); `content-length` handled
      correctly for the transfer mode used; auth and provider headers (`openai-organization`,
      `openai-project`, any `x-*` the client sent) forwarded unchanged; **no header added, renamed,
      or reordered.**
- [ ] **A5 — errors pass through unchanged**, including non-JSON bodies, 429 with `retry-after`,
      and upstream connection failures surfaced as a distinguishable Observer error (not a 500
      that looks like the provider's).
- [ ] **A6 — fail-open (I1), tested not asserted.** Kill the store mid-request; the request is still
      forwarded and the response still returned, with the failure logged and counted.
- [ ] **A7 — added latency p50 < 15 ms, p99 < 40 ms** on the no-policy path (T7's budget), measured
      by the rig over ≥1000 requests.
- [ ] **A8 — explicit protocol refusal.** A request that is not recognisably OpenAI Chat Completions
      (e.g. `tools[].input_schema` ⇒ Anthropic) returns `501 unsupported-protocol`. **Never
      best-effort a dialect we have not implemented** — with 51 provider modules and 25 compat flags
      in the wild (§4A.4), silent mis-normalisation is worse than refusal.

**Underestimated because:** "it's just a proxy" is the most expensive sentence in this document.
Concrete traps: `fetch()`/undici will re-encode a parsed body, so the obvious implementation fails
A1/A2 on day one — use a raw pipe with an **incremental** hash (bodies exceed 10 MB at 1M-token
context; buffering to hash is not viable). Client abort must propagate upstream. And note the honest
limit of A2 on target one: because qwen applies no prefix check (§4A.2), **a violation produces no
error** — only cache loss and corrupted reasoning. The tests are the only detection there is.

---

### V2 — Capture store `[P]`
**Deps:** V1 · **Parallel with:** V3, V4
**Scope:** `store/` (`append`/`read`/`list`), `capture/` write-behind spool.

**Acceptance criteria**
- [ ] Crash-safe: `kill -9` mid-append leaves all prior records readable; a torn tail record is
      detected and skipped, never parsed as valid.
- [ ] Concurrent appenders across N parallel sessions produce no interleaved corruption.
- [ ] **Capture is off the request path.** Write-behind queue with bounded memory; appending a
      10 MB request+response pair adds **< 5 ms** to the critical path.
- [ ] **Backpressure drops capture, never stalls traffic** (I1). Every drop is counted and surfaced
      — a silent capture gap is a silent audit gap, and the dashboard must show it (V9).
- [ ] `store/` exposes **no** hashing API. Enforced by a dependency-boundary test.

---

### V3 — Chat Completions request normaliser (permissive) `[P]`
**Deps:** V1 (fixtures) · **Parallel with:** V2, V4
**Scope:** `transcript/` types; `gateway/adapters/openai-chat/request.ts`.

**Acceptance criteria**
- [ ] **Round-trip identity:** `normalise → denormalise` is byte-identical on every fixture. This is
      far harder than normalisation and is the criterion most likely to be quietly dropped.
      **Recommended implementation: raw bytes are truth, the normalised form is an index.** Store the
      original body and make denormalise a *splice*, never a re-serialisation — a canonical-JSON
      writer that preserves key order, number formatting and `undefined`-vs-absent is a project of
      its own.
- [ ] Unknown top-level and per-message fields preserved in an `extras` bag; **never dropped**.
- [ ] `reasoning_content` / `reasoning` / `reasoning_text` normalise to first-class **`reasoning`**
      blocks (recon §3: DSH's own block types are `reasoning`, `text`, `tool-call`), each recording
      the field it came from as **`replayField`** — never `signature`, because on this dialect it is
      a field name, not a cryptographic value (§4A.3).
- [ ] Tool calls carry `index`, `id`, `function.name`, `function.arguments` (raw string) plus parsed
      args when valid, with `argsParseError` preserved verbatim when not.
- [ ] `role: "tool"` messages map to `tool_result` blocks joined by `tool_call_id`, retaining
      `is_error` semantics.
- [ ] **Blocks are the atom, not messages.** Wire messages do not map 1:1 to logical turns — DSH's
      Anthropic-path serializer merges consecutive same-role messages and rewrites `tool`→`user`
      (`serialize.ts:121,125,126-128`), and the OpenAI path groups consecutive tool results
      (`openai-completions.js:1078`). Every block records the wire message and index it came from.
- [ ] Every block carries `prov = {captureId, pointer, sha256, author}` (I2).
- [ ] Every reasoning block carries `protection: {kind: 'none' | 'openai-encrypted' |
      'anthropic-signature' | ...}` so downstream code can ask "is this block protected?" without
      knowing the protocol. On qwen the answer is `'none'` — **and that must be represented
      explicitly, not defaulted**, because `'none'` means Observer's own discipline is the only
      control (§4A.2).

---

### V4 — SSE streaming pass-through, byte-faithful `[P]` ⚠️ *largest risk in the slice*
**Deps:** V1 · **Parallel with:** V2, V3
**Scope:** `gateway/` streaming path; `capture/` stream recording.

**Acceptance criteria**
- [ ] **Socket-byte identity.** Bytes delivered to the client are identical to bytes received from
      upstream, **including chunk boundaries**. Asserted on the raw byte stream, not on parsed
      events — a rig that parses before comparing cannot detect coalescing.
- [ ] **Incremental delivery.** TTFB delta vs direct < 5 ms. Mock upstream emits one event per TCP
      write at 50 ms intervals; client must observe the same intervals ±5 ms. No coalescing, no
      buffering-to-completion.
- [ ] Handles an SSE event split across TCP writes **and** across `Transfer-Encoding: chunked`
      boundaries.
- [ ] **Compression decision made and recorded.** With `content-encoding: gzip`/`br`, decompressing
      to observe and re-compressing breaks byte identity. **Chosen approach: pass through untouched;
      decompress a copy for observation.** Any other choice must be justified in writing here.
- [ ] `data: [DONE]` forwarded exactly once and **never JSON-parsed** (§4.3).
- [ ] `obfuscation` field preserved on every chunk (§4.1) — named regression test, because its only
      purpose is to be present and sized, so dropping it is invisible to every other test.
- [ ] Client disconnect mid-stream: upstream aborted, partial capture recorded and marked
      `incomplete`, no unhandled rejection, no leaked socket, no hung keep-alive agent.
- [ ] Upstream failure mid-stream (error payload, or socket reset after headers) forwarded
      faithfully; capture records the truncation offset.
- [ ] HTTP/1.1 **and** HTTP/2 both pass the rig. Note OpenAI's own reader drains the body on 1.1 but
      not on 2 (§4.3) — do not assume the client drains.
- [ ] Long silence tolerated: tool-input streaming legitimately pauses mid-block (§1.2), and
      `usage` may be absent entirely if the stream is interrupted (§4.1). No read-timeout in
      Observer may be shorter than the upstream's own behaviour.

**Underestimated — see §3.** This is the task that will decide whether the slice ships.

---

### V5 — Streaming response normaliser + tool-call reassembly
**Deps:** V3, V4 · **Parallel:** no — **spine after the two tracks rejoin**
**Scope:** `gateway/adapters/openai-chat/stream.ts`.

**Acceptance criteria**
- [ ] Deltas accumulated keyed by **`(choice_index, tool_calls_index)`**; interleaved parallel tool
      calls reassemble correctly (interleaving is legal, §4.2).
- [ ] **Streamed ≡ unstreamed.** For a fixture pair (same prompt, `stream: true` and `false`), the
      reassembled `arguments` string equals the non-streamed `function.arguments` byte-for-byte.
      This equivalence test is the core criterion for this task.
- [ ] `id` taken from whichever fragment carries it — **not assumed to be the first** (§4.2 A2) —
      and never invented when absent.
- [ ] **No per-tool-call boundary is fabricated.** Chat Completions has none before `finish_reason`
      (§4.2). Tool calls are emitted at `finish_reason` or stream end, with
      `streaming.boundaryKnown: false` recorded. Any downstream code that assumes otherwise is a
      bug, and the type should make it unrepresentable.
- [ ] Truncated / malformed argument JSON ⇒ `argsParseError` set; **never** emit a partial that
      parses as valid.
- [ ] `reasoning_content` fragments concatenated into a `reasoning` block with `replayField`
      recorded. **Empty-string reasoning preserved, not dropped** (§4A.4).
- [ ] `usage` tolerated when absent on all chunks, null on non-final chunks, or missing because the
      stream was interrupted (§4.1). Every metric degrades to `unknown`, never to `0`.
- [ ] Unknown delta fields preserved.
- [ ] **Retry de-duplication.** The OpenAI SDK retries 429/5xx by default, so Observer will see the
      same logical request more than once, sometimes as partial streams. Deduplicate responses by
      `(id, created)` — both documented as identical across all chunks of one completion (§4.1) —
      and requests by body hash. **Without this the ledger double-counts evidence and every
      noise-density number is wrong.** Not priced anywhere in round 1; it is a real task.

---

### V6 — Session identity, declared-first `[P]`
**Deps:** V3 · **Parallel with:** V4, V5, V7
**Scope:** `gateway/session.ts`.

**Acceptance criteria**
- [ ] ID resolved in order: `X-Observer-Session` header → `prompt_cache_key` → `safety_identifier`
      → `user` → else `synthetic`.
- [ ] **No lease ⇒ observe-only, permanently.** Enforced in the type system: the mutation path takes
      a `Lease` argument that cannot be constructed without a hard declared signal. Not a config
      flag, not a confidence threshold (T1's round-1 conclusion: a lease, not a number).
- [ ] **Blocking unknown resolved in V0:** does DSH forward a custom header to the provider? If not,
      fall back to `prompt_cache_key` (verify DSH sets it — §4A.4 notes OpenAI recommends a stable
      key for cache routing, and `prompt_cache_key` is used in the harness) or accept
      `synthetic` + observe-only. Either outcome is shippable; *not knowing* is not.
- [ ] Fork/retry disambiguation: same declared ID with a divergent transcript prefix ⇒
      `session-fork-detected`; **never merge**.
- [ ] Cold start: a session first seen mid-conversation is flagged `partial-transcript: true`, and
      every detector must respect that flag — no detector may claim full-coverage on a partial
      session. (This also feeds T14's audit: the gateway cannot audit what it did not see.)
- [ ] Group scoping hook present but inert: `groupId?` on the session record, populated from nothing
      in this slice. T13 needs it; retrofitting it later is a migration.

---

### V7 — Ledger + hash chain `[P]`
**Deps:** V2, V3 · **Parallel with:** V4, V5, V6
**Scope:** `ledger/`.

**Acceptance criteria**
- [ ] Every tool call/result pair becomes an evidence entry keyed by `callId`, carrying
      `artifactKey`, `contentSha256`, `isError`, cwd, timestamp, and provenance terminating in an
      observed wire message.
- [ ] `artifactKey` canonicalisation: paths resolved against the tool's `meta.cwd` (DSH emits it —
      recon §2); command args stripped of volatile tokens (timestamps, PIDs, temp paths, nonces).
      **Fixture set built from the 73 real session files**, because getting this wrong makes every
      dedupe detector a false-positive factory.
- [ ] Hash chain: replaying a capture reproduces every hash; tampering with entry *n* invalidates
      *n* onward; `verify` exits non-zero.
- [ ] Append-only **at the type level** — no update or delete API exists to call.
- [ ] **`unverified` is first-class and is never coerced to `grounded`.** A checker that throws,
      times out, or finds nothing yields `checker-error` / `unverified`, never `pass`. Named test
      (this is the I1 reinterpretation from T12, encoded).
- [ ] Evidence whose provenance does **not** terminate in an observed wire message is capped at
      `unverified` — the filesystem is attacker-writable, so `stat()` success alone never grounds a
      claim (T12).

---

### V8 — Observe-only detectors `[P]`
**Deps:** V7 · **Parallel with:** V9, V10
**Scope:** `detectors/` — exactly three in this slice.

**Acceptance criteria**
- [ ] **Primary: loop signature** — same tool + normalised args (+ same error class) repeated ≥3
      times. This is the highest-value detector in the system per the empirical update in §0, and it
      is nearly free. Acceptance is concrete: **replayed against the corpus session containing the
      891 byte-identical `sed` calls, the detector fires within ≤20 iterations**, not at the end of
      the session. If it does not, the normalisation is wrong.
- [ ] Secondary: **duplicate-read** (byte-identical `artifactKey`, T15 R1).
- [ ] Diagnostic only: **noise density ρ** with components ρ_dup / ρ_retry / ρ_stale / ρ_pruned
      (T4 + T15). Reported per session with components; **never aggregated corpus-wide and never a
      trigger**, because 84% of corpus duplicate events come from one session (§0).
- [ ] Each detector is pure, one file, no shared state, deletable without touching a scheduler —
      enforced by a boundary test, not a convention.
- [ ] **Every signal carries the evidence IDs and block refs that produced it.** No signal without a
      citation; a signal that cannot cite is a bug.
- [ ] **No detector may emit an action.** `detectors/` returns `Signal`; only `policy/` returns
      `Action`, and in this slice policy is hard-wired to `observe`. Enforced by type.
- [ ] ρ computed over the **surface**, excluding pruned/elided mass, with ρ_pruned reported
      separately (T15 Q1). Marker-stubs are exempt from ρ but counted in ρ_pruned.
- [ ] **The drift signal must not share a term with ρ.** The study's central methodological finding
      is that a drift proxy containing a *repeat fraction* and a noise proxy containing *duplicate
      bytes* count the same events and correlate at lag 0 by construction — which is exactly what
      produced the artefactual "drift-leads" tilt. Any future drift detector shipped here must be
      built from terms disjoint from ρ (scope violations, progress rate from `todo/write`, error
      rate), and this must be an explicit review check, not a remembered caveat.
- [ ] Every detector respects `partial-transcript` and degrades to `coverage: partial` rather than
      reporting a full-coverage number computed from a partial view.

---

### V9 — Dashboard, read-only `[P]`
**Deps:** V2, V8 · **Parallel with:** V8's second half, V10
**Scope:** `apps/dashboard/` — an app reading `store` read-only. **Not a package.**

**Acceptance criteria**
- [ ] Session timeline: turns, tokens (input / cached-read / output), tool calls with `artifactKey`,
      evidence entries, signals, verdicts.
- [ ] **Observer's own cost is visible**: bytes captured, detector milliseconds, store drops, tokens
      spent (zero in v1). The tax is never hidden (T7).
- [ ] **Capture gaps are visible holes**, not silent ones — every V2 backpressure drop shows on the
      timeline.
- [ ] Every session shows its **lease** and **`partial-transcript`** status, so an operator can see
      at a glance which sessions are observe-only and why.
- [ ] Read-only: no write path to `store` exists in the app. Enforced by dependency-boundary test.
- [ ] **Scope cap:** one session view, one list view. No editing, no policy UI, no configuration
      screens. Scope creep here is the most likely way the slice misses its date.

---

### V10 — Prefix-divergence alarm (fidelity canary) `[P]`
**Deps:** V3, V6 · **Parallel with:** V8, V9
**Scope:** `detectors/prefix-divergence.ts`.

**Acceptance criteria**
- [ ] Classifies each consecutive-request transition as `append-only | in-place-edit | hole |
      unknown-prefix-edit` using skeleton alignment `(role, [blockTypes], [toolCallIds])` then
      content hashes — **block-level, not message-level**, because wire messages are role-merged
      (§4A.5, T15 Q2). Longest common prefix *and* suffix; a compaction shows as a **hole**, not a
      truncation (`retainRatio: 0.16`).
- [ ] Detects DSH's checkpoint by **literal wire signature** — `CHECKPOINT_PREAMBLE` plus
      `<compacted-summary>` tags (`summarizer.ts:22-23,70,190`) — and records `compactionId`.
      Registry entries carry `detectableFrom: 'wire-signature' | 'wire-differential' | 'log-only'`
      (T16 Q5 refinement) and `lastVerifiedAgainst`.
- [ ] Unmatched shrink ⇒ `signature-drift` finding, never a silent fallback (T14's registry-rot
      warning).
- [ ] Emits `cache-forfeit` measured from `usage` deltas across a detected edit, degrading to
      `unknown` when `supportsUsageInStreaming` is false (§4A.5).
- [ ] **Its most important v1 job is self-surveillance:** with Observer's write path disabled, any
      `in-place-edit` or `unknown-prefix-edit` on a supervised session is a **P0 alarm**, because it
      means our pass-through is mutating traffic. This is the production regression test for V1's
      byte-identity guarantee, and it is the only one that runs against real agents.

---

## 3. Where the work is underestimated

Ordered by how much I think the first estimate will be wrong by.

1. **V4 (SSE fidelity) — 3–5×.** I said this in round 1 and I'll repeat it with specifics, because
   it is the task that gets compressed to hit a date and then haunts the project. Compression
   (pass-through vs re-encode is a *decision*, not a detail), chunk-boundary preservation,
   backpressure when the store write is slow, client abort mid-block, upstream failure after
   headers, `[DONE]` handling, HTTP/1.1-vs-2 drain semantics, and long legitimate silences inside a
   tool-input block are each a day of edge cases. **Do not let this be one task on a board; make it
   five.**
2. **V0 fixture acquisition — potentially a whole extra task.** If DSH's session log does not contain
   full request bodies (recon shows header/context records, not obviously the message array), then
   capturing fixtures needs a logging tap first. Resolve on day 1. Everything downstream has
   acceptance criteria that say "on every fixture", so no fixtures means no verification.
3. **V1 byte-identity — the obvious implementation fails.** `fetch()` + `JSON.stringify` breaks A1
   and A2 immediately, and it is what gets written first. Bodies at 1M-token context exceed 10 MB,
   so hashing must be incremental and streaming, not buffered.
4. **V3 round-trip identity — harder than normalisation by a wide margin.** Any lossy step (dropping
   `undefined`, reordering keys, `1.0`→`1`) breaks it. The "raw bytes are truth, normalised form is
   an index" decision needs making in V3's design, not discovered in V5.
5. **V5 retry de-duplication — nobody priced it.** SDK-level retries on 429/5xx mean duplicate and
   partial requests are the *normal* case, not an edge case. Without dedup the ledger double-counts
   and every ρ number is wrong. This would have been found in production, not in review.
6. **V6's header question — blocking and cheap.** Whether DSH forwards a custom header decides
   whether the lease mechanism has any hard signal to work with. One hour of investigation, and it
   gates the entire identity design.
7. **Dialect breadth.** 51 provider modules, 25 compat flags (§4A.4). v1 must target **exactly one**
   configuration — DSH→qwen as deployed — and refuse everything else explicitly (V1/A8). The
   temptation to "also handle DeepSeek while we're in there" is how a two-week slice becomes a
   quarter. The capability table is v1 *infrastructure* (a persisted per-session record), but only
   one entry is populated.
8. **V9 dashboard scope.** Stated twice because it always happens.

---

## 4. Dependency graph and parallelisation

```
V0 ──► V1 ──┬──► V2 ─────────────────┐
            ├──► V3 ──┬──► V6 ──┐    │
            │         ├──► V7 ──┼──► V8 ──► V9
            │         └──► V10 ◄┘     ▲
            └──► V4 ──────────┐       │
                              ▼       │
                     (V3,V4) ► V5 ────┘  [V5 feeds V8's tool-aware signals]
```

**Critical path:** `V0 → V1 → V3 → V7 → V8 → V9`.
**Longest risk item:** `V4`, which is *off* the critical path but is the most likely to blow up.
Run it in parallel from the moment V1 lands and staff it best.

| Track | Tasks | Notes |
|---|---|---|
| **A — fidelity** | V4 → V5 | Highest risk. Do not serialise behind the semantics track. |
| **B — semantics** | V3 → V7 → V8 | The critical path. |
| **C — infra** | V2, V6, V9, V10 | Genuinely parallel; V9 can start against a stub store. |

**With one person** this is ~strictly sequential and V4 is the long pole — plan for it explicitly
rather than discovering it. **With three**, tracks A/B/C run concurrently after V1 and the slice is
gated by V4, not by the sum.

**Strictly sequential, no parallelism available:** V0 → V1 (nothing can be verified without the rig,
and nothing is safe without byte-identity).

---

## 5. Definition of done for the slice

The slice is done when **all** of the following hold, demonstrated on real DSH→qwen traffic rather
than mocks:

1. A live DSH session runs to completion through Observer with **no behavioural difference** the
   agent can detect — verified by byte-identity on both directions and by V10 reporting
   `append-only` for every transition.
2. The dashboard renders that session: turns, tokens including cache-read, tool calls, evidence
   entries, and the three detectors' signals with citations.
3. The loop detector fires within ≤20 iterations on the corpus's 891-call thrashing session, and ρ
   with its four components renders per session on the dashboard. **No thresholds are tuned in this
   slice** — corpus-level measurement is already done in `docs/research/noise-drift-study.md`; the
   slice's job is to reproduce its per-session numbers live, not to re-derive them.
4. Fail-open is demonstrated by killing the store mid-session: traffic continues, capture gaps are
   visible on the dashboard, and the session is marked degraded.
5. **Zero mutations were made.** `git log` on the capture store shows no request body differing from
   what the client sent. This is the slice's actual product.

---

## 6. Explicit non-goals

Not in this slice, and any PR that adds one should be closed:

- Any mutation of any request or response body. No injection, no labelling, no annotation.
- Any injection inventory row (T16) — including the "safe" append-only ones. Injection on
  Anthropic requires stateful replay at stable indices (§4A.8); that is a later milestone and it is
  harder than the qwen case, which is the opposite of the round-1 ordering.
- The Anthropic Messages adapter and the OpenAI Responses adapter. Both stay in D3 scope for v1 but
  **after** this slice proves out. Responses additionally has the unsolved `R-server-state`
  injection question (gap A15) and often carries no transcript on the wire at all (§5.3).
- Any LLM judge (P4). Any cleaning or compaction writer (T15/T14). The `watcher/` package.
- **Any context-cleaning writer justified by drift reduction.** `docs/research/noise-drift-study.md`
  finds no empirical support for a cleaner as a drift-prevention device (§0). A future cleaning
  feature may still be argued on context-size, cost, or signal-to-noise grounds — but not on this
  one, and the distinction should be checked at review time because "it reduces drift" is the
  intuitive and now-falsified justification.
- Policy configuration. `policy/` exists as a pure function hard-wired to `observe`.

---

## 7. Two things to decide before V1 starts

1. **Compression stance (V4).** Pass through untouched and decompress a copy for observation —
   recommended, and the only option consistent with byte-identity. Anything else needs writing down
   here with a justification.
2. **Fixture source (V0).** Whether DSH's session log carries full request bodies. If it does not,
   V0a (a logging tap) becomes the spine start and everything shifts.

Both are cheap to resolve and expensive to discover late.

---

## 8. Lead resolutions to §7 (2026-11-09)

**§7.1 Compression stance (V4): RESOLVED — pass through untouched, decompress a copy for
observation.** Accepted as recommended. It is the only stance consistent with byte-identity, and
byte-identity is the slice's entire claim. Any future deviation must be written here with a
justification, per your own instruction.

**§7.2 Fixture source (V0): RESOLVED BY MEASUREMENT — the log does NOT carry wire request bodies,
so V0a (logging tap) is required. But the critical path is not fully blocked.**

Verified directly against a real session file rather than inferred:

- `request/header.data.header` parses to exactly `{config, tools}`. `'messages' in header` is
  **false**. There is no request-body record of any kind; the only `request/*` shapes in the file
  are `request/header: header,reason` and `request/context: provider,model,contextWindow`.
- However the **logical** conversation is fully present: 19 `user/message`, 90 `assistant/message`,
  105 `tool/result`, each with `content`, `role`, `source`, `id`.

Consequence, and it splits your fixture problem in two:

| Fixture need | Source | Status |
|---|---|---|
| **Byte-exact wire requests** (V1 byte-identity, V4 SSE fidelity, V10 prefix-divergence canary) | Must be captured live — **V0a logging tap** | **Blocking.** A reconstruction cannot test byte identity; that is the whole point of those acceptance criteria. Your §3.2 warning is confirmed, not merely possible. |
| **Logical transcript events** (V7 ledger, V8 detectors, including the 891-call `sed` replay) | Reconstructable from the session log **today** | **Not blocking.** Detectors operate on `(name, normalised-args, isError, seq)`, all present in the log. |

So: build V0a early, but **do not gate V7/V8 on it**. Derive the V8 golden fixture — session
`e89e7501`, the 891-byte-identical-`sed` thrash loop — from the log now, since that replay is a
hard acceptance criterion and the data already exists. This is also the honest reason the
watcher adapter earns its place in v1: it is the only fixture source we have until the tap works.

**One further constraint on V0a, from the round-2 finding on `reasoning_content`:** the tap must
record **raw bytes**, not a parsed-and-re-serialised body. `reasoning_content` is absent from
OpenAI's own `ChoiceDelta` schema, so a typed tap would silently drop 100% of reasoning on target
one and every fixture captured through it would be wrong in a way no test would catch.
