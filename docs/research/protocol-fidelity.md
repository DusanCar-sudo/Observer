# Protocol Fidelity Research — Observer v1

**Author:** `aura` · **Date:** 2026-11-09 · **Status:** Round 1 research input (rev. 2)
**Scope:** Anthropic Messages API, OpenAI Chat Completions, OpenAI Responses API (D3),
plus the **OpenAI-compatible dialect layer** that the actual first supervised target speaks.
**Purpose:** Ground every protocol claim in T3 / T8 / T10 in fetched documentation, per §0 rule 3
of `BRAINSTORM.md`. Nothing here is recalled from memory.

> **Rev. 2 — reprioritisation after `lead`'s recon.** `docs/recon/dsh-session-format.md` §3
> establishes that DSH on this machine talks to `qwen`/`qwen3.8-max` over an **OpenAI-compatible**
> wire (`tools[].parameters`, not Anthropic's `input_schema`). Chat Completions is therefore the
> **priority** protocol and Anthropic second. §4A below is new and is the most consequential
> section in this document: it establishes, from the harness's own adapter source, that
> **"OpenAI Chat Completions" is not one protocol but a family of ≥51 provider dialects with
> three mutually incompatible reasoning-integrity regimes.** That changes the T3 and T8 answers.
> New evidence class `[SRC]` is introduced for claims read from local harness/library source.

## Verification standard used

Every behavioural claim below is tagged:

- `[DOC]` — stated in official provider documentation fetched on 2026-11-09. URL given.
- `[SDK]` — stated in provider-generated SDK type/source code (generated from the provider's own
  OpenAPI spec). URL given. Weaker than `[DOC]` but authoritative on wire shape.
- `[SRC]` — read from source code installed on this machine (the DSH runtime and its
  `@earendil-works/pi-ai` provider layer). Local path given. Authoritative for **what our first
  supervised target actually does**, and for what real OpenAI-compatible endpoints emit, but it is
  *not* a provider specification — it is one integrator's accumulated workarounds, which is
  arguably better evidence of dialect divergence than a spec would be.
- `[ASSUMPTION]` — **not** verifiable from anything fetched. Explicitly flagged. These are the
  places a design built on this document could still be wrong.

Anthropic docs were fetched via the `.md` mirror of `platform.claude.com/docs/...`; OpenAI via
`developers.openai.com/api/docs/...`. `platform.openai.com/docs/api-reference/*` returns HTTP 403
to non-browser clients, so the OpenAI *API reference* pages could **not** be fetched; OpenAI wire
shape is sourced from the guides plus the Castiron-generated SDK types instead. That gap is noted
wherever it matters.

---

## 0. Executive summary — the five questions, answered

| Question | Answer |
|---|---|
| Anthropic SSE lifecycle | `message_start` → N × (`content_block_start` → ≥0 `content_block_delta` → `content_block_stop`) → ≥1 `message_delta` → `message_stop`, plus arbitrary `ping` and `error` events anywhere. §1 |
| Anthropic cache invalidation | Prefix-hash, cumulative, hierarchy `tools` → `system` → `messages`. Changing a block invalidates that level **and all later levels**. Minimum cacheable 512–4096 tokens by model; below it, silently uncached with **no error**. §2 |
| **Are reasoning blocks integrity-protected?** | **It depends on the dialect, and there are three regimes.** (1) **Anthropic:** opaque `signature` per thinking block; **tampering is always a hard 400**, and any edit to `system`/`tools`/preceding `messages` fails a *prefix check* that invalidates that block **and every later thinking block**. (2) **OpenAI first-party Responses:** opaque `encrypted_content`; a prefix edit makes the API **silently drop** reasoning items after the edit. (3) **OpenAI-compatible (what DSH/qwen actually speaks): NO protection at all** — reasoning is plain text on `delta.reasoning_content` (or `reasoning` / `reasoning_text`), string-concatenated by the client and replayed as a plain string field. Some providers instead use `reasoning_details`, which *does* carry opaque encrypted entries. Some require reasoning folded into text with `<thinking>` delimiters. §3, §4A |
| OpenAI Chat Completions streaming | `chat.completion.chunk` objects; tool-call arguments arrive as raw string fragments on `delta.tool_calls[].index`. **There is no per-tool-call terminator** — a tool call ends only when a new `index` appears or `finish_reason: "tool_calls"` arrives. Stream ends with the SSE `data: [DONE]` sentinel. §4 |
| OpenAI Responses statefulness | Optional and server-side: `store` (default true, 30-day retention), `previous_response_id`, and the Conversations API (`conversation` param, no 30-day TTL). Stateless mode requires replaying `output` verbatim including encrypted reasoning items. §5 |

**The headline finding for Observer, stated plainly:**

> Response-path buffering (holding a content block and re-emitting it verbatim, in order) is
> **legal on all three protocols**. Editing reasoning content, reordering blocks, or appending to
> an existing message is **illegal on Anthropic (HTTP 400) and silently destructive on OpenAI
> first-party**.
>
> Therefore the dangerous half of Observer is **not** T3's response-side holdback. It is the
> **request-side** mutations the other pillars depend on — Goal Card injection into `system`,
> compaction rewriting `messages`, annotation appended to an existing turn. On current Anthropic
> models those are prefix edits, and on accounts created on/after 2026-08-31 a prefix edit
> **fails the supervised agent's request with a 400**. That is a direct violation of invariant I1
> caused by Observer working as designed.
>
> **But on the actual first target the failure is the opposite and, in a way, worse.** Against
> qwen over OpenAI-compatible Chat Completions, reasoning is unprotected plain text (§4A). Nothing
> will reject an edit. Observer can silently rewrite a supervised agent's chain of thought and
> **no protocol layer will ever tell anyone it happened** — not a 400, not an
> `input_transformations` entry, not a cache diagnostic. The absence of integrity protection is
> not permission; it is the removal of the only automatic detector we were going to get.

Both providers document **append-only native primitives** that achieve Observer's goals without a
prefix edit. §6 lists them; they should replace the invented mechanisms in T4/T5/T6.

---

## 1. Anthropic Messages API — streaming

Source: <https://platform.claude.com/docs/en/build-with-claude/streaming> `[DOC]`

### 1.1 Event lifecycle

The documented flow `[DOC]`:

1. `message_start` — contains a `Message` object with **empty `content`**. Under the
   `thinking-binding-controls-2026-08-01` beta header this object also carries the
   `input_transformations` array.
2. A series of content blocks, each with `content_block_start`, ≥0 `content_block_delta`, and
   `content_block_stop`. Each has an `index` corresponding to its position in the final `content`
   array. **Exception:** during server-side fallback a `fallback` content block arrives as a
   `content_block_start`/`content_block_stop` pair **with no deltas in between**.
3. One or more `message_delta` events — top-level changes to the final `Message`. After a
   mid-stream server-side fallback, the final `message_delta` carries `input_transformations`
   again with the serving model's entries.
4. `message_stop`.

Verbatim example from the docs `[DOC]`:

```sse
event: message_start
data: {"type": "message_start", "message": {"id": "msg_1nZd...", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-5-5", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}

event: message_stop
data: {"type": "message_stop"}
```

Facts a proxy must respect:

- `ping` events: *"Event streams might also include any number of `ping` events."* `[DOC]`
- `error` events mid-stream: e.g. `event: error` / `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, corresponding to HTTP 529 non-streaming. `[DOC]`
- **Unknown event types:** *"In accordance with the versioning policy, new event types may be added, and your code should handle unknown event types gracefully."* `[DOC]` → a proxy that drops unrecognised events is non-conformant.
- **`usage` in `message_delta` is cumulative**, not incremental. `[DOC]`
- `message_delta` may occur **more than once** and is not purely terminal metadata. `[DOC]`
- Blocks are emitted sequentially by `index`; the docs show no interleaving of two open blocks.
  Whether interleaving is possible is **not documented** → `[ASSUMPTION]` treat indices as
  non-interleaved, but implement defensively (key state by `index`, not by "current block").

### 1.2 Delta subtypes

| Block type | Delta type | Payload | Notes |
|---|---|---|---|
| `text` | `text_delta` | `{"type":"text_delta","text":"..."}` | `[DOC]` |
| `tool_use` | `input_json_delta` | `{"type":"input_json_delta","partial_json":"..."}` | Deltas are **partial JSON strings**; final `tool_use.input` is always an **object**. Accumulate and parse at `content_block_stop`. `[DOC]` |
| `thinking` | `thinking_delta` | `{"type":"thinking_delta","thinking":"..."}` | Corresponds to the `thinking` field. `[DOC]` |
| `thinking` | `signature_delta` | `{"type":"signature_delta","signature":"..."}` | Sent **just before** `content_block_stop`. *"This signature is used to verify the integrity of the thinking block."* `[DOC]` |

Tool-input streaming granularity `[DOC]`: *"Current models only support emitting one complete key
and value property from `input` at a time. As such, when using tools, there might be delays
between streaming events while the model is working."* — i.e. **long silences inside a single
`tool_use` block are normal provider behaviour**, and clients already tolerate them. This matters
for T3's timeout design (§6.4).

Fine-grained tool streaming exists and is opt-in per tool via `eager_input_streaming`; it removes
server-side buffering of parameter values. `[DOC]` (referenced from the streaming page; the
dedicated page <https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming>
was **not** fetched → details `[ASSUMPTION]`.)

### 1.3 Server tools and the limits of gating

The web-search example `[DOC]` shows blocks the model does **not** execute client-side:

```sse
event: content_block_start
data: {..."content_block":{"type":"server_tool_use","id":"srvtoolu_014...","name":"web_search","input":{}}}
...
event: content_block_start
data: {..."content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_014...","content":[{"type":"web_search_result","title":"...","url":"https://...","encrypted_content":"Ev0DCioIAxgCIiQ3NmU4...","page_age":null},...]}}
event: content_block_stop
data: {"type":"content_block_stop","index":2}
```

Two consequences for Observer:

1. `web_search_tool_result` carries its own `encrypted_content` blob — another opaque payload that
   must round-trip untouched. `[DOC]`
2. **The side effect has already happened upstream** by the time Observer sees the result block.
   Gating `server_tool_use` cannot prevent the search; it can only delay the agent learning about
   it. Any enforcement story built on "hold the tool call" applies **only to client-executed
   tools**. `[DOC]`-derived, and a material limit on T3(d).

Also note the zero-delta block is real here too (`index:2` opens and closes with no deltas). A
block state machine must accept `start → stop` with nothing between. `[DOC]`

### 1.4 Stop reasons observed in docs

`end_turn`, `tool_use` `[DOC, streaming page]`; `model_context_window_exceeded` — returned when
generation reaches the context limit on Claude 4.5+ instead of an error `[DOC, thinking page]`.
The full enum was not fetched → treat as open. `[ASSUMPTION]`

---

## 2. Anthropic prompt caching

Source: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> `[DOC]`

### 2.1 Two modes

- **Automatic caching** — a single top-level `cache_control: {"type":"ephemeral"}` on the request
  body; the system applies the breakpoint to the last cacheable block and moves it forward as the
  conversation grows. `[DOC]`
- **Explicit breakpoints** — `cache_control` placed on individual content blocks (in `system`,
  `messages`, or on a tool in `tools`). `[DOC]`

`ephemeral` is currently the only supported cache type. `[DOC]`

### 2.2 What the cache actually covers

> *"Prompt caching references the entire prompt: `tools`, `system`, and `messages` (in that
> order), up to and including the block designated with `cache_control`."* `[DOC]`

> *"Cache writes occur only at your breakpoint. Marking a block with `cache_control` writes
> exactly one cache entry: a hash of the prefix ending at that block. The system does not write
> entries for any earlier position. Because the hash is cumulative, covering everything up to and
> including the breakpoint, **changing any block at or before the breakpoint produces a different
> hash on the next request**."* `[DOC]`

Worked failure case from the docs (a timestamp in the prompt): *"The timestamp differs, so the
prefix hash at block 6 differs. The lookback walks through blocks 5, 4, 3, 2, and 1, but the
system never wrote an entry at any of those positions. **No cache hit.** You pay for a fresh cache
write on every request and never get a read."* `[DOC]`

> **This is the exact cost model for "rewriting the middle of a context".** If Observer mutates a
> block before the last breakpoint, the client pays a **full cache write** and gets **zero
> reads** — worse than having no cache breakpoints at all. `[DOC]`-derived.

- **Exact matching:** *"Cache hits require 100 percent identical prompt segments, including all text and images up to and including the block marked with cache control."* `[DOC]`
- **Isolation:** workspace-level on the Claude API / Claude Platform on AWS / Microsoft Foundry; organisation-level on Bedrock and Google-managed. Never shared across organisations. `[DOC]`

### 2.3 Minimum cacheable prefix

Verbatim `[DOC]`:

> 512 tokens — Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, Claude Opus 5, Claude Sonnet 5.5, Claude Fable 5, Claude Mythos 5, Claude Haiku 5.5
> 2,048 tokens — Claude Mythos Preview, Claude Opus 4.7
> 4,096 tokens — Claude Opus 4.6, Claude Opus 4.5
> 1,024 tokens — Claude Opus 4.8, Claude Sonnet 5, Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Opus 4.1, Claude Opus 4, Claude Sonnet 4
> 4,096 tokens — Claude Haiku 4.5

> *"Shorter prompts cannot be cached, even if marked with `cache_control`. Any requests to cache
> fewer than this number of tokens are processed without caching, **and no error is returned**.
> To check whether a prompt was cached, look at the response usage fields: if both
> `cache_creation_input_tokens` and `cache_read_input_tokens` are 0, the prompt was not cached."* `[DOC]`

**Consequence for the compaction pillar:** compaction can shrink a session below the minimum and
silently destroy caching with no error surfaced to anyone. The only observable is
`cache_read_input_tokens == 0`. → **Cache-hit rate must be a first-class compaction safety metric
on the dashboard**, not a cost footnote.

### 2.4 What invalidates — the documented matrix

Hierarchy `tools` → `system` → `messages`; *"Changes at each level invalidate that level and all
subsequent levels."* `[DOC]`

| Change | tools cache | system cache | messages cache | Doc note |
|---|---|---|---|---|
| Tool definitions (names, descriptions, parameters) | ✘ | ✘ | ✘ | *"invalidates the entire cache"* |
| Speed setting (`speed:"fast"` ↔ standard) | ✓ | ✘ | ✘ | |
| Tool choice | ✓ | ✓ | ✘ | *"only affect message blocks"* |
| Thinking parameters | model-specific | model-specific | ✘ | *"rendered into the prompt, so changing it always invalidates message blocks"* |
| Effort (`output_config.effort`) | model-specific | model-specific | ✘ | setting it to the model default ≡ omitting it |
| Presence/absence of images anywhere | — | — | ✘ | *"Changes to `tool_choice` or the presence/absence of images anywhere in the prompt invalidate the cache"* |

Escape hatches documented `[DOC]`:

- Append a `{"role":"system"}` message to `messages` instead of editing top-level `system` —
  *"you can add a new system instruction partway through a conversation without invalidating the
  system or message caches"* (available on Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5,
  Opus 4.8, Opus 5, Sonnet 5.5, Haiku 5.5; **not** on Claude Sonnet 5).
- `inline-tools-2026-09-15` beta: send a tool definition in a `tool_addition` block inside a
  mid-conversation system message and leave `tools` untouched — *"The cached prefix still
  matches, so only the appended message is processed as new input."* Exception: a `tools` array
  with no non-deferred tool costs one full cache miss.

### 2.5 TTL and lifetime

- Default **5-minute** lifetime; refreshed at no cost on each use. Optional **1-hour** at 2× base
  input price (5-min writes are 1.25×). `[DOC]`
- **Lifetime is measured from the start of the request that writes or reads the entry, not the end
  of its response.** *"if a response takes 4 minutes to stream, a follow-up request that reuses the
  same cached prefix must start within about 1 minute of that response completing."* `[DOC]`
  → **Observer's own holdback latency is charged against the client's cache lifetime.** A
  T3 design that holds blocks for seconds on a long streaming response can cause the *next* turn
  to miss cache. Not previously priced in T3 or T7.
- Mixing TTLs: *"Cache entries with longer TTL must appear before shorter TTLs."* `[DOC]`
- If the last block has an explicit `cache_control` with a different TTL → **400 error**. `[DOC]`

### 2.6 Usage fields observed

`usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`,
`usage.cache_read_input_tokens`, and `usage.server_tool_use.web_search_requests`. All appear in
doc examples. `[DOC]` Any finer breakdown (e.g. per-TTL creation counts) was **not** verified →
capture usage opaquely. `[ASSUMPTION]`

---

## 3. Reasoning / thinking block integrity — **the decisive question**

**Answer: integrity protection is real, is documented, and is enforced. It is not a guess.**

### 3.1 Anthropic — `signature`, opaque and verified

Sources: <https://platform.claude.com/docs/en/build-with-claude/thinking> and
<https://platform.claude.com/docs/en/build-with-claude/preserved-thinking> `[DOC]`

- *"Each thinking block also carries a `signature` field, an **encrypted copy of the full
  reasoning** that you pass back unchanged in multi-turn and tool-use conversations."*
- *"Full thinking content is encrypted and returned in the `signature` field on each thinking
  block. **The API uses the signature to verify that thinking blocks were generated by Claude when
  you pass them back.**"*
- *"The `signature` field is opaque: don't interpret or parse it."*
- Streaming: *"the signature arrives as a `signature_delta` inside a `content_block_delta` event
  just before the `content_block_stop` event."* And from the streaming page: *"This signature is
  used to **verify the integrity of the thinking block**."*
- *"**A block sent back with an empty `signature` fails.**"*
- `redacted_thinking` blocks carry an opaque encrypted `data` field with no readable text; the
  docs instruct passing them back unchanged, and warn that filtering on
  `block.type == "thinking"` silently drops them and *"breaks the multi-turn protocol"*.
- `display: "omitted"` returns thinking blocks with an **empty `thinking` field but a populated
  signature**. *"If you parse the stream yourself, keep the block even when no thinking text
  arrives: it opens, receives its `signature` in a `signature_delta` event, and closes."*
  → **A proxy that drops "empty" blocks silently deletes reasoning.** This is a concrete,
  likely pass-through bug.

**What counts as tampering — hard failure, no escape hatch:**

> *"A tampered or undecryptable signature is a different failure. It **always returns a 400
> error** (`Invalid \`signature\` in \`thinking\` block` with no sentence about the
> conversation), and `prefix_mismatch_behavior` doesn't apply to it."* `[DOC]`

**The prefix check (Claude 5.1 and later models):**

> *"a thinking block stays valid only while everything you sent before it is unchanged on later
> requests. The checked prefix has three parts: the top-level `system` prompt; the set of
> `tools`; every `message` before the block."* `[DOC]`

> *"Request parameters outside those three fields, such as `effort`, `max_tokens`,
> `output_config`, `tool_choice`, and `metadata`, **aren't part of the prefix check, and neither
> are `cache_control` markers**."* `[DOC]`

> *"If the prefix differs from what you sent when the block was produced, **that block and every
> later thinking block fail the prefix check**."* `[DOC]`

**The gap rule (critical for compaction):**

> *"Earlier thinking blocks aren't in the prefix, but each thinking block records which thinking
> block came before it, across turns. You can remove the oldest thinking blocks (from the start of
> the history), the newest (from the end), or all of them. **What fails is a gap: the thinking
> blocks you keep must be an unbroken run of the original sequence, so removing one from the
> middle invalidates the thinking blocks after it.** Once you remove a block, leave it out.
> Putting it back invalidates the thinking blocks produced while it was gone."* `[DOC]`

**What happens on failure — depends on the account, and this is the I1 hazard:**

With `thinking.block_binding.prefix_mismatch_behavior` (requires beta header
`thinking-binding-controls-2026-08-01`):

- `"error"` → 400 `invalid_request_error` naming the first failing block.
- `"drop_block"` → drops each failing block and every thinking block after it; request succeeds;
  dropped blocks aren't billed; *"the prompt cache restarts at the edit"*; reported in
  `input_transformations` with `reason: "prefix_binding_mismatch"`. Documented as a **stopgap**:
  *"Dropping blocks can significantly increase output tokens… and output quality might change."*

**With the field unset** `[DOC]`:

| Model | Account created on/after 2026-08-31 | Account created before |
|---|---|---|
| Claude Fable 5.1 | **400 error** | no error (failing blocks reach the model) |
| Claude Mythos 5.1 | **400 error** | **400 error** |
| Claude Opus 5.5 | **400 error** | no error |
| Claude Sonnet 5.5 | **400 error** | no error |
| Claude Haiku 5.5 | **400 error** | no error |

The 400 message begins:
``messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different
conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to
"drop_block".`` `[DOC]`

> **Observer consequence.** If Observer edits the prefix and the supervised agent's account is in
> the left column, **the agent's next request fails with a 400 that Observer caused.** That is not
> a degradation; it is Observer breaking the supervised agent, which I1 exists to forbid. And
> because the column depends on the *client's* account creation date, Observer cannot know which
> regime it is in without probing.

**Model binding:** each model reads only its own thinking blocks plus a fixed set of others; an
unreadable block is *"dropped, not rejected"*, silently, without billing. Blocks from Claude
Sonnet 5.5 / Haiku 5.5 are additionally **account-bound** — dropped when sent from a different
account. `[DOC]`

> **Observer consequence:** if Observer ever re-routes a session to a different model or a
> different API key (e.g. its own judge key used for a continuation), reasoning is silently lost.
> Observer must never substitute credentials on a supervised request.

**The provider's own list of "prefix edits" is a list of Observer's planned features** `[DOC]`:

- *"Rebuilds the `system` prompt"* → **T5 Goal Card injection**
- *"Re-renders the context in the first user message"* → environment blocks
- *"Clears or shortens old tool results, or re-encodes old images"* → **T4 continuous dedupe/truncation**
- *"Summarizes or drops old turns on the client"* → **T4 compaction**
- *"Adds, removes, or edits entries in `tools`"* → **T3(d) tool gating by removal**
- *"Adds a reminder to a user turn and removes or rewrites it later"* → **T5 per-turn nudges**
- *"Drops some `thinking` blocks and keeps later ones"* → any reasoning-aware compaction
- *"A serializer that drops unknown block types, drops empty fields, or reorders blocks edits the
  prefix for every later turn."* → **the pass-through gateway itself**

Also `[DOC]`: *"A run with no errors on your own API key doesn't prove that your code keeps the
prefix intact"* — because on pre-cutoff accounts failing blocks silently reach the model. Testing
must set `prefix_mismatch_behavior: "error"` explicitly.

### 3.2 Anthropic — the documented append-only replacements

`[DOC]`, preserved-thinking "Replace prefix edits" table and following sections:

| Observer wants to… | Prefix-editing way (**illegal**) | Documented replacement | Beta header |
|---|---|---|---|
| Inject new instructions / Goal Card | rebuild top-level `system` | append `{"role":"system","content":"…"}` inside `messages` | mid-conversation system messages |
| Per-turn nudge / reminder | append to a user turn, delete later | system message with `clear_at: "next_user_message"` — *"It adds nothing to what the model receives and costs no input tokens, but because it's still in the array, the thinking in `messages[4]` stays valid."* | `mid-conversation-system-clear-at-2026-08-21` |
| Withdraw a dangerous tool | edit `tools` | `{"type":"tool_removal","tool":{"type":"tool_reference","name":"delete_branch"}}` in a system message | `inline-tools-2026-09-15` or `mid-conversation-tool-changes-2026-07-01` |
| Add a tool discovered late | edit `tools` | `tool_addition` with `{"type":"tool_definition", …}` | `inline-tools-2026-09-15` |
| Change effort | top-level `output_config.effort` (restarts cache) | `{"role":"system","content":[],"output_config":{"effort":"low"}}` | `mid-conversation-output-config-2026-07-01` |
| Compact | client-side summarise + keep tail | on-demand compaction / threshold compaction / context editing (`clear_tool_uses_20250919`, `clear_thinking_20251015`) — *"The server-side equivalents don't count as edits"* | `compact-2026-09-04` etc. |
| Compact on the client anyway | keep-tail with stale thinking | **simple compaction**: summarise the whole session into one user message and replay nothing earlier — *"Nothing earlier is replayed, so there's no thinking left to fail the check"* | none |
| Reference an image/doc | URL whose bytes change | `file_id` from the Files API, or base64 | none |

Placement rule for injected system messages `[DOC]`: *"In a tool loop, place the message after the
`tool_result` user message, **never between an assistant `tool_use` and its `tool_result`**."*
And: *"Once sent, the message is part of the prefix for later thinking: leave it in place on later
requests."* → **Observer's injections are permanent additions to the transcript, not transient
overlays.** That has direct consequences for T11 (attribution) and for the must-carry set in T6.

Telemetry `[DOC]`: under `thinking-binding-controls-2026-08-01` every response carries a
top-level `input_transformations` array (on `message_start` when streaming) listing each dropped
or mismatched block with a JSON-pointer `path` and a `reason`
(`model_binding_mismatch`, `organization_binding_mismatch`, `prefix_binding_mismatch`,
`thinking_mismatch_allowed`). Example:

```json
{"input_transformations": [{"type": "thinking_dropped", "path": "messages.3.content.0", "reason": "model_binding_mismatch"}]}
```

> **This is a free, provider-issued receipt of whether Observer broke the prefix.** It should be
> captured on every response from day one — in observe-only v1 — and surfaced as a hard alarm.
> Recommendation: Observer should *add* this beta header on supervised Anthropic requests only if
> the client tolerates unknown response fields; otherwise capture it when present. Adding a beta
> header is itself a request mutation and must be logged under I2. `[ASSUMPTION]` on client
> tolerance — must be tested against real SDKs.

### 3.3 OpenAI — `encrypted_content`, drop-not-reject

Sources: <https://developers.openai.com/api/docs/guides/preserved-reasoning>,
<https://developers.openai.com/api/docs/guides/reasoning>,
<https://developers.openai.com/api/docs/guides/conversation-state> `[DOC]`;
<https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_item.py> `[SDK]`

- Reasoning items are opaque. *"Persisted reasoning provides continuity; it does not expose the
  model's raw reasoning. The reasoning items remain opaque, and the API does not return their
  reasoning text."* `[DOC]`
- `ResponseReasoningItem.encrypted_content` — *"The encrypted content of the reasoning item. This
  is populated by default… **When streaming, use the completed reasoning item and its
  `encrypted_content` from the `response.output_item.done` event** in subsequent requests. The
  `encrypted_content` in `response.output_item.added` **may be incomplete**."* `[SDK]`
  → A proxy that snapshots items on `.added` will persist a **truncated** blob. Concrete bug.
- *"For stateless reasoning-model requests, preserve every item in the response's `output` array.
  The Responses API returns encrypted reasoning items by default."* `[DOC]`
- **Enforcement is silent dropping, not an error:** *"Starting with newer frontier models, the API
  **will drop reasoning items** that follow a prefix edit. When reasoning items are dropped, the
  model may have to redo some reasoning, which can increase token usage, cost, and latency. If the
  model can't recover the lost reasoning, output quality may also drop."* `[DOC]`
- What counts as a prefix change: *"updating Responses API parameters such as `tools`,
  `instructions`, or `text.format`, or by editing earlier `input` items"*; also *"shortening a
  tool result, rewriting a developer message, or replacing older turns with a summary."* `[DOC]`
- Reasoning reuse is **model-family-bound**: *"reasoning does not carry between the GPT-5.6 and
  GPT-5.5 families"*; incompatible reasoning is omitted even under `reasoning.context: "all_turns"`. `[DOC]`
- Assistant messages carry a `phase` field (`commentary` | `final_answer`) that must be
  round-tripped: *"If you replay assistant history manually, preserve each original `phase`
  value. Missing or dropped `phase` can cause preambles to be treated as final answers."* `[DOC]`
  → Another field a naive normaliser would drop.
- OpenAI's documented append-only replacements `[DOC]`: `configuration_update` item (effort,
  structured-output schema), `additional_tools` item (tools), appended `developer` message
  (instructions), and OpenAI's own compaction — *"If you use OpenAI compaction via
  `/responses/compact` or `context_management`, our systems retain subsequent reasoning items
  despite the prefix being edited."*
- **Custom compaction placement rule:** *"place the compacted item at the **end** of the model's
  context, instead of before recent turns."* `[DOC]` — the opposite of the intuitive design, and a
  direct constraint on T4.
- Diagnostics: `prompt_cache_options.comparison_response_id` + Prompt Cache Diagnostics report the
  first identified difference — but *"Diagnostics report the first identified difference on a
  best-effort basis; **they can't verify whether the model reused reasoning**."* `[DOC]`
  → On OpenAI there is **no** equivalent of `input_transformations`. Prefix damage is only
  inferable from cache-hit deltas. Weaker observability than Anthropic.
- **Chat Completions exposes no reasoning at all:** *"While reasoning tokens are not visible via
  the API, they still occupy space in the model's context window and are billed as output
  tokens."* `[DOC]` → On Chat Completions there is nothing to protect and nothing to hold; the
  reasoning-integrity problem **does not exist** for that protocol.

### 3.4 Verdict table — what a MITM may and may not do

| Operation | Anthropic Messages | OpenAI Responses | OpenAI Chat Completions |
|---|---|---|---|
| Delay a whole block, then re-emit **verbatim, in order** | **Legal** — bytes unchanged | **Legal** | **Legal** (delay whole chunks) |
| Drop the **last** reasoning block(s) | Legal (remove from tail) | Legal | n/a (none exposed) |
| Drop **all** reasoning blocks | Legal | Legal | n/a |
| Drop a reasoning block from the **middle** | **Breaks**: gap invalidates all later thinking | Drop-cascade, silent | n/a |
| Edit reasoning **text**, keep signature | **400 always** — "tampered signature" | **Undefined**; blob is opaque, assume breakage `[ASSUMPTION]` | n/a |
| Re-sign / re-encrypt reasoning | **Impossible** (provider-side crypto) | **Impossible** | n/a |
| Reorder blocks within a message | **Prefix edit** → 400 or drop-cascade | Prefix edit → silent drop | Order of `delta`s is observable state; reordering corrupts accumulation `[ASSUMPTION]` |
| Edit top-level `system` / `instructions` | Prefix edit → invalidates all thinking | Prefix edit → silent drop | Cache miss only |
| Edit `tools` | Prefix edit + full cache invalidation | Prefix edit → silent drop | Cache miss only |
| Append to an **existing** message | Prefix edit | Prefix edit; also breaks cache-breakpoint placement | Breaks cache reuse (*"extending a message can prevent reuse of its cached prefix"*) |
| Append a **new** message at the end | **Legal & recommended** | **Legal & recommended** | Legal |
| Drop unknown/empty blocks in a re-serialised body | Prefix edit for every later turn | Prefix edit | Cache miss |

**Bottom line for T3:** *holding* is legal; *editing reasoning* is not merely discouraged, it is
rejected by the API. Per-block buffering survives contact with the protocols **provided the
gateway is byte-faithful on re-emit and never mutates a protected block.**

---

## 4. OpenAI Chat Completions — streaming

Sources:
<https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion_chunk.py> `[SDK]`
(header: *"File generated from our OpenAPI spec by Castiron"*),
<https://github.com/openai/openai-python/blob/main/src/openai/_streaming.py> `[SDK]`,
<https://developers.openai.com/api/docs/guides/reasoning> `[DOC]`.
The `platform.openai.com` API reference returned **HTTP 403** to this client, so no `[DOC]`
citation is available for the chunk schema itself. Flagged as a research gap in §7.

### 4.1 Chunk shape `[SDK]`

`ChatCompletionChunk`:

| Field | Behaviour |
|---|---|
| `object` | always `"chat.completion.chunk"` |
| `id` | *"A unique identifier for the chat completion. **Each chunk has the same ID.**"* |
| `created` | *"**Each chunk has the same timestamp.**"* |
| `model`, `system_fingerprint`, `service_tier` | present per chunk |
| `choices` | *"Can contain more than one element if `n` > 1. **Can also be empty for the last chunk** if you set `stream_options: {"include_usage": true}`."* |
| `usage` | *"only present when you set `stream_options: {"include_usage": true}`… contains a **null value except for the last chunk**… **If the stream is interrupted or cancelled, you may not receive the final usage chunk.**"* |
| `obfuscation` | *"An obfuscation string added to **normalize the size of streamed chunks as a mitigation to certain side-channel attacks**. The field is included by default and omitted when `stream_options.include_obfuscation` is `false`."* |
| `moderation` | present on a moderation chunk when moderated completions are requested |

> **`obfuscation` is a pass-through trap.** It is a field whose *only* purpose is that its bytes
> are present and sized. A proxy that parses a chunk into a typed struct and re-serialises it will
> drop `obfuscation` (and any other unknown field) and thereby change the very property the field
> exists to provide. **Rule: forward the response body as bytes; parse a copy.** `[SDK]`-derived.

`choices[].delta` (`ChoiceDelta`) fields: `content`, `role`, `refusal`, `audio`,
`function_call` (deprecated), `tool_calls`. `choices[].finish_reason` ∈
`stop | length | tool_calls | content_filter | function_call`; *"Omitted from the final audio
update containing only `delta.audio.expires_at`."* `[SDK]`

### 4.2 Tool-call argument fragments `[SDK]`

```
delta.tool_calls[]:
  index: int                    # REQUIRED — the only stable correlator
  id: Optional[str]             # "The ID of the tool call."
  type: Optional["function"]    # "Currently, only `function` is supported."
  function:
    name: Optional[str]
    arguments: Optional[str]    # raw JSON *string fragment*
```

Documented on `arguments`: *"The arguments to call the function with, as generated by the model in
JSON format. Note that **the model does not always generate valid JSON, and may hallucinate
parameters not defined by your function schema**. Validate the arguments in your code before
calling your function."* `[SDK]`

> Worth quoting in the architecture spec: the provider's own type stubs tell integrators that tool
> arguments may be hallucinated. Observer's thesis is not speculative; it is a documented
> integration hazard.

Correlation is by `index`, and `id` is optional per chunk. That `id` appears only on the first
fragment for a given index is the universal client behaviour but is **not stated** in anything
fetched → `[ASSUMPTION]`; implement by treating `id` as "set once, remember it".

**End-of-tool-call marking — the key asymmetry:** there is **no** `arguments.done`-style event in
Chat Completions. A tool call is complete only when (a) a fragment with a different `index`
appears, or (b) `finish_reason: "tool_calls"` arrives, or (c) the stream ends. `[SDK]`-derived —
no `[DOC]` page fetched states this explicitly, so treat as `[ASSUMPTION]` with strong SDK
support. Consequence for T3: **per-tool-call gating on Chat Completions requires buffering to
`finish_reason`, i.e. essentially the entire response.**

### 4.3 Stream termination `[SDK]`

From OpenAI's own SSE reader:

```python
if sse.data.startswith("[DONE]"):
    # HTTP/1.1 needs the remaining body consumed for connection reuse.
    # HTTP/2 can close this stream and keep the connection, so draining
    # it would add unnecessary latency after [DONE].
    if response.http_version == "HTTP/1.1":
        await drain_response_async(response)
    break
```

So: `data: [DONE]` terminates the stream, and correct client behaviour differs by HTTP version.
A proxy must (a) emit `[DONE]` exactly once at the end, and (b) not assume the client drains.
`[SDK]`

### 4.4 Reasoning

None exposed (§3.3). Reasoning models work better on Responses: *"Reasoning models work better
with the Responses API. While the Chat Completions API is still supported, you'll get improved
model intelligence and performance by using Responses."* And for the newest models, *"Chat
Completions does not support function calling with GPT-6 Astra or GPT-6.1 Sol."* `[DOC]`

> **Consequence for D3:** Chat Completions is a *declining* target. Supporting it faithfully is
> still required (huge installed base), but it is the protocol where Observer's enforcement powers
> are weakest (no tool-call boundary, no reasoning, no keepalive event) and where the provider is
> actively steering new models away. Budget accordingly.

---

## 5. OpenAI Responses API — event stream and statefulness

Sources: <https://developers.openai.com/api/docs/guides/streaming-responses> `[DOC]`,
<https://developers.openai.com/api/docs/guides/function-calling> `[DOC]`,
<https://developers.openai.com/api/docs/guides/conversation-state> `[DOC]`,
<https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_stream_event.py> `[SDK]`

### 5.1 Event stream

*"The Responses API uses semantic events for streaming. Each event is typed with a predefined
schema."* `[DOC]` Common lifecycle: `response.created` → … → `response.completed`, plus `error`.

`ResponseStreamEvent` is a discriminated union (`PropertyInfo(discriminator="type")`) of **63
event types** in the current SDK `[SDK]`, including:
`response.created`, `response.queued`, `response.in_progress`, `response.completed`,
`response.failed`, `response.incomplete`, `error`,
`response.output_item.added` / `.done`, `response.content_part.added` / `.done`,
`response.output_text.delta` / `.done`, `response.output_text.annotation.added`,
`response.refusal.delta` / `.done`,
`response.function_call_arguments.delta` / `.done`,
`response.custom_tool_call_input.delta` / `.done`,
`response.reasoning_text.delta` / `.done`,
`response.reasoning_summary_part.added` / `.done`, `response.reasoning_summary_text.delta` / `.done`,
`response.audio.delta` / `.done`, `response.audio_transcript.delta` / `.done`,
`response.compaction.compacting`,
plus per-tool families: `web_search_call.*`, `file_search_call.*`, `code_interpreter_call.*`,
`image_gen_call.*`, `mcp_call.*`, `mcp_list_tools.*`, `shell_call.*`.

> **63 event types versus Anthropic's ~7.** The Responses adapter is the largest single piece of
> protocol work in v1 and is almost certainly underestimated in any task breakdown. Note also
> `response.compaction.compacting` — OpenAI compacts server-side and *tells you on the stream*.

### 5.2 Tool-call streaming — a real per-call boundary `[DOC]`

Verbatim from the function-calling guide:

```
{"type":"response.output_item.added","response_id":"resp_1234xyz","output_index":0,"item":{"type":"function_call","id":"fc_1234xyz","call_id":"call_1234xyz","name":"get_weather","arguments":""}}
{"type":"response.function_call_arguments.delta",...,"item_id":"fc_1234xyz","output_index":0,"delta":"{\""}
{"type":"response.function_call_arguments.delta",...,"delta":"location"}
{"type":"response.function_call_arguments.delta",...,"delta":"\":\""}
{"type":"response.function_call_arguments.delta",...,"delta":"Paris"}
{"type":"response.function_call_arguments.delta",...,"delta":","}
{"type":"response.function_call_arguments.delta",...,"delta":" France"}
{"type":"response.function_call_arguments.delta",...,"delta":"\"}"}
{"type":"response.function_call_arguments.done",...,"arguments":"{\"location\":\"Paris, France\"}"}
{"type":"response.output_item.done",...,"item":{"type":"function_call","id":"fc_1234xyz","call_id":"call_1234xyz","name":"get_weather","arguments":"{\"location\":\"Paris, France\"}"}}
```

Accumulation rule from the docs' own snippet: key by `output_index`, take the item from
`output_item.added`, append each `delta`. `.done` gives the complete `arguments` string.
`[DOC]`

→ **Responses supports true per-tool-call gating; Chat Completions does not.** Any T3 design that
claims uniform behaviour across D3's three protocols is wrong.

### 5.3 Statefulness

Three modes `[DOC]`:

1. **Stateless** — replay the full `input` array each turn, *"preserve every item in the
   response's `output` array"* including encrypted reasoning items.
2. **`previous_response_id`** — server-side chaining. *"Response objects are saved for **30 days**
   by default… You can disable this behavior by setting `store` to `false`."* *"Even when using
   `previous_response_id`, all previous input tokens for responses in the chain are billed as
   input tokens."*
3. **Conversations API** — `conversation: <id>` on the Responses call. *"Conversation objects and
   items in them are **not** subject to the 30 day TTL."*

Also documented: WebSocket mode with `response.create` events and `stream_id` lanes, where
*"previous_response_id still controls lineage, so a new lane can fork from a response on another
lane."* `[DOC]`

> **Observer consequence — the hardest part of the Responses adapter, and it is not in T8 or
> T10.** In modes 2 and 3 **the transcript is not in the request.** The body may be
> `{model, previous_response_id, input: "now patch the bug"}`. A gateway that normalises only what
> it sees on the wire will reconstruct almost nothing: no system prompt, no history, no tool
> results, no evidence. Observer must either
> (a) shadow-store every `response.output` it proxies and reconstitute the chain from
> `previous_response_id` — which makes Observer's store the *only* complete copy of the session,
> a serious data-handling responsibility; or
> (b) treat stateful Responses sessions as **observe-lite**: session identity from
> `previous_response_id`/`conversation`, evidence only from what passes the wire, and an explicit
> `partial-transcript` flag on the session so no detector ever claims full coverage.
> T1's "reconstruct from the transcript" option (c) is **impossible** on stateful Responses.
> `[DOC]`-derived.

### 5.4 Moderation and streaming

*"streaming the model's output in a production application makes it more difficult to moderate the
content of the completions, as partial completions may be more difficult to evaluate."* And
moderation scores *"arrive after the full generated output is available. They aren't included with
partial output deltas."* `[DOC]`

> The provider independently confirms T3's core tension: **streaming and pre-delivery judgement are
> in fundamental conflict.** OpenAI's own answer is to judge after the fact. Worth citing when the
> Human asks why Observer cannot both stream and block.

### 5.5 Incomplete / terminal states `[DOC]`

`status: "incomplete"` with `incomplete_details.reason ∈ {max_output_tokens, content_filter}`;
*"This might occur before any visible output tokens are produced, meaning you could incur costs
for input and reasoning tokens without receiving a visible response."*

---

## 6. Derived design constraints for Observer

These follow from §1–§5. They are the part of this document that should change the spec.

### 6.1 Byte-faithful pass-through is a correctness requirement, not an optimisation

A gateway that `JSON.parse` → mutate → `JSON.stringify` the **request** body can silently:
drop unknown fields; drop empty fields (deleting Anthropic `thinking` blocks with
`display:"omitted"`); reorder object keys; change number/string escaping; drop `phase`
(OpenAI) or `obfuscation` (OpenAI chunks). On Anthropic each of these is a **prefix edit that
invalidates every later thinking block** and, on post-cutoff accounts, **400s the agent's
request**. `[DOC]`

→ v1 must forward request and response bodies as **opaque bytes** on the no-mutation path, and
parse only a copy for observation. When mutation becomes necessary it must be surgical
(splice at a known byte range), never a full re-serialisation, and must be diffed against the
original.

### 6.2 Never append to an existing message; always add a new one

Documented on both providers (Anthropic prefix rules; OpenAI *"Extending a message can prevent
reuse of its cached prefix"*). This constrains T5's Goal Card and T6's annotation format: they
must be **new trailing messages**, never edits. `[DOC]`

### 6.3 Prefer provider-native append-only primitives over invented ones

§3.2's table. Every mechanism Observer invents for injection, tool withdrawal, or compaction has
a documented provider equivalent that does not invalidate reasoning and does not restart the
cache. Inventing our own is strictly worse: more code, more risk, and it breaks the client's
reasoning continuity. `[DOC]`

Caveat: these primitives are **beta-header-gated** and **model-gated** (mid-conversation system
messages are unavailable on Claude Sonnet 5; `block_binding` needs
`thinking-binding-controls-2026-08-01`). Observer needs a **capability table per model ×
platform**, and must fall back safely when a primitive is unavailable. Adding a beta header to a
client's request is itself a mutation → log it under I2, and make it policy-controlled.
`[DOC]` + `[ASSUMPTION]` on client tolerance.

### 6.4 Holdback latency has three costs, not one

1. Client read timeout. **No provider documents a keepalive for OpenAI**; Anthropic has `ping`
   (`{"type":"ping"}`) which is protocol-legal to synthesise. Whether SDKs tolerate *injected*
   pings at arbitrary frequency is **not documented** → `[ASSUMPTION]`, must be tested.
2. **Anthropic cache lifetime is measured from request start**, so a 4-minute stream plus
   Observer holdback can push the follow-up turn past the 5-minute window (§2.5). `[DOC]`
3. Intra-block silence is already normal for tool input (§1.2), so clients tolerate gaps — but
   the tolerated gap is bounded by *their* HTTP client config, which we cannot see. `[ASSUMPTION]`

### 6.5 Capture `input_transformations` from day one

It is the only authoritative signal that Observer damaged a supervised session's reasoning, and it
exists **before** any mutation feature ships. Shipping it in observe-only v1 gives a baseline: if
`prefix_binding_mismatch` entries ever appear, Observer is already breaking prefixes merely by
existing. `[DOC]`

### 6.6 Enforcement power is protocol-dependent — plan for asymmetry

| Capability | Anthropic | OpenAI Responses | OpenAI Chat Completions |
|---|---|---|---|
| Per-block boundary | ✅ `content_block_stop` | ✅ `output_item.done` | ⚠️ message-level only |
| Per-tool-call boundary | ✅ | ✅ `function_call_arguments.done` | ❌ none before `finish_reason` |
| Keepalive event | ✅ `ping` | ❌ not documented | ❌ not documented |
| Reasoning to protect | ✅ signature (400 on tamper) | ✅ encrypted (silent drop) | — none exposed |
| Transcript visible on wire | ✅ always | ❌ not with `previous_response_id`/`conversation` | ✅ always |
| Provider prefix-damage telemetry | ✅ `input_transformations` | ⚠️ cache diagnostics only, best-effort | ⚠️ cache diagnostics only |

Any architecture doc claiming uniform behaviour across D3 is wrong. **Recommend the spec name a
"least common enforcement capability" and design v1 to it**, with per-protocol upgrades.

### 6.7 Server-side tools cannot be gated

§1.3. `server_tool_use` / `web_search_tool_result` (Anthropic) and `web_search_call.*` /
`file_search_call.*` / `code_interpreter_call.*` / `mcp_call.*` (OpenAI Responses) execute
upstream. Holding the block delays *knowledge* of the action, not the action. T3(d)'s value
applies to client-executed tools only. `[DOC]`-derived.

---

## 7. Research gaps and assumptions register

Not verified from documentation. Each is a place this document could still be wrong.

| # | Claim / gap | Status |
|---|---|---|
| A1 | Content blocks never interleave across `index` in Anthropic streams | `[ASSUMPTION]` — docs show only sequential; not stated as a guarantee |
| A2 | OpenAI Chat Completions `delta.tool_calls[].id` appears only on the first fragment for an index | `[ASSUMPTION]` — SDK marks it `Optional`; behaviour inferred from universal client code |
| A3 | Chat Completions has no per-tool-call terminator event | `[ASSUMPTION]` (strong) — no `[DOC]` page fetched; `platform.openai.com` API reference returned **403** |
| A4 | Chunk schema for `chat.completion.chunk` | `[SDK]` only — generated from OpenAI's OpenAPI spec, but not a doc page |
| A5 | SSE `data: [DONE]` terminates Chat Completions **and** Responses streams | `[SDK]` — one shared reader in `openai-python`; Responses-specific confirmation not fetched |
| A6 | SDKs tolerate synthetically injected Anthropic `ping` events at arbitrary cadence | `[ASSUMPTION]` — must be tested against real SDKs before relying on it for keepalive |
| A7 | Editing an OpenAI `encrypted_content` reasoning item produces a specific error | **Not documented** — only drop-on-prefix-edit is documented. Assume breakage; never attempt |
| A8 | Whether clients tolerate an added `anthropic-beta` header value they did not request | `[ASSUMPTION]` — must test; it is a request mutation |
| A9 | Fine-grained tool streaming (`eager_input_streaming`) exact semantics | `[ASSUMPTION]` — dedicated page not fetched |
| A10 | Full `stop_reason` / `finish_reason` enums | Partially verified; treat as open and forward unknown values |
| A11 | Anthropic `usage` sub-breakdowns beyond the four verified field names | `[ASSUMPTION]` — capture opaquely |
| A12 | Client HTTP read-timeout defaults for DSH / Claude Code / generic agents | **Not documented anywhere** — must be measured empirically per target (P2) |
| A13 | Anthropic server-side compaction / context-editing parameter details | Not fetched — pages exist (`/build-with-claude/compaction`, `/context-editing`) and should be read before designing T4 |
| A14 | OpenAI `/responses/compact` and `context_management` parameter details | Not fetched — `/api/docs/guides/compaction` should be read before designing T4 |

**Recommended follow-up fetches before the architecture spec is written:** A13, A14 (both
directly determine whether Observer should implement compaction at all or delegate it to the
provider), A6 and A12 (both block any holdback design), and A9.

---

## 8. Sources

Fetched 2026-11-09.

**Anthropic**
1. Streaming Messages — <https://platform.claude.com/docs/en/build-with-claude/streaming>
2. Prompt caching — <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
3. Thinking — <https://platform.claude.com/docs/en/build-with-claude/thinking>
4. Preserved thinking (prefix check, `input_transformations`, replace-prefix-edits) —
   <https://platform.claude.com/docs/en/build-with-claude/preserved-thinking>

**OpenAI**
5. Reasoning models — <https://developers.openai.com/api/docs/guides/reasoning>
6. Keep the prefix unchanged (preserved reasoning) —
   <https://developers.openai.com/api/docs/guides/preserved-reasoning>
7. Conversation state — <https://developers.openai.com/api/docs/guides/conversation-state>
8. Streaming API responses — <https://developers.openai.com/api/docs/guides/streaming-responses>
9. Prompt caching — <https://developers.openai.com/api/docs/guides/prompt-caching>
10. Function calling (Responses streaming tool-call events) —
    <https://developers.openai.com/api/docs/guides/function-calling>

**OpenAI SDK source (Castiron-generated from OpenAI's OpenAPI spec)**
11. `ChatCompletionChunk` — <https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion_chunk.py>
12. `ResponseReasoningItem` — <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_item.py>
13. `ResponseStreamEvent` union (63 event types) — <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_stream_event.py>
14. SSE reader / `[DONE]` handling — <https://github.com/openai/openai-python/blob/main/src/openai/_streaming.py>

**Not fetched (403 / not reached):** `platform.openai.com/docs/api-reference/*` (HTTP 403 to
non-browser clients); Anthropic `compaction`, `compaction-on-demand`, `context-editing`,
`mid-conversation-system-messages`, `fine-grained-tool-streaming`; OpenAI `compaction`.
