# Recon: DSH session log format (v4) and wire protocol

**Author:** `lead`
**Date:** 2026-11-09
**Status:** GROUNDED — every claim below was read from a real session file on this machine, not
from memory or documentation. Reproduce with the command in §6.
**Why this exists:** provisional decision P2 names DeepSeek Harness as Observer's first supervised
target. Before designing adapters against it, we need to know what it actually emits. Three
findings below change the plan.

---

## 1. Where sessions live, and what that gives us for free

```
~/.dsh/sessions/<slugified-workspace-path>/<session-id>/
    session.v4.jsonl.zstd      # zstd-compressed JSONL, one record per line
    session.lock               # empty; presence signals a live session
```

Example workspace slug: `--mnt-bigdata-projects-Observer--` for `/mnt/bigdata/projects/Observer`.
Slashes become `-`, and `~` appears literally in the slug.

73 session files exist on this machine across 20 workspaces, largest 17 MB compressed.

**Consequence for T1 (session identity).** For the *watcher* path, session identity is not a
problem at all — it is a directory name plus a `session` record carrying an explicit UUID. The
hard inference problem in T1 applies **only to the gateway path**, where requests arrive
stateless. That is a meaningful narrowing of T1's scope and should be reflected in the answer.

**Consequence for T13 (teams).** The session record already carries the group structure:

```json
{"type":"session","version":4,"id":"85f6d33c-2e34-4676-859c-24ea51cdcd8b",
 "createdAt":1794216816202,"cwd":"/mnt/bigdata/projects/Observer",
 "parentSession":"session-85ce1928-5e1d-4e4d-a306-3b85b4a56224",
 "isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

`parentSession` + `delegationDepth` + `cwd` are exactly the three signals T13 needs to build a
session group and decide evidence visibility. We do not have to infer them. Note `origin:
"subagent"` — DSH distinguishes seeded/forked/lead sessions natively.

---

## 2. Record envelope and census

Every record is `{type, seq, time, data}`, except the `session` record which carries its identity
fields at top level and has no `data`.

Census from one real 198-record session:

| Category | Record types |
|---|---|
| Lifecycle | `session`, `turn/start` (2), `turn/end` (1), `step/start` (23), `step/end` (22), `session/title`, `session/end-seed` |
| Conversation | `user/message` (9), `assistant/message` (22), `system/message` (1) |
| Tools | `tool/call` (38), `tool/result` (38) |
| Request wire | `request/header` (2), `request/context` (1) |
| Agent state | `todo/write` (1), `agent/inbox/spliced` (8), `subagent/descriptor` (1) |
| Governance | `sandbox/mode` (1), `approval/policy` (1) |
| Jobs | `job/registered` (12), `job/settled` (12) |

**This census is close to a gift.** Mapping it onto Observer's needs:

| Observer needs | DSH already emits |
|---|---|
| Evidence Ledger entries (T2) | `tool/call` + `tool/result` joined by `callId`, with `isError` and `meta.cwd` |
| Loop / thrash detection (T5 signal 3) | `tool/call.name` + normalised `arguments` + `tool/result.isError`, all timestamped |
| Progress accounting (T5 signal 4) | `todo/write` — `{todos:[{content,status}]}`, no inference needed |
| Scope-violation detection (T5 signal 2) | `sandbox/mode` (`workspace-write`) and `approval/policy`, with `source` |
| Compaction denominator (T4) | `request/context.contextWindow` |
| Cache economics (T4) | `assistant/message.usage.cacheReadTokens` |
| Team / group scoping (T13) | `session.parentSession`, `delegationDepth`, `origin` |
| Per-turn drift window (T5) | `turn/start` / `turn/end`, `step/*` |

The watcher adapter for DSH is therefore **cheap and high-fidelity**. We are not parsing prose to
guess at structure; the structure is already typed.

---

## 3. Wire protocol: OpenAI-shaped, not Anthropic-shaped  ⚠️ corrects P2

`request/header.data.header` (stored as an object, not a string) is:

```json
{"config":{"provider":"qwen","model":"qwen3.8-max"},
 "tools":[{"name":"...","description":"...","parameters":{...}}, ...]}   // 40 tools
```

**The discriminator: `tools[].parameters`.** Anthropic's Messages API uses `input_schema`;
OpenAI's function-calling schema uses `parameters`. This deployment therefore speaks an
**OpenAI-compatible** protocol to its model provider. `request/context` confirms
`{"provider":"qwen","model":"qwen3.8-max","contextWindow":1000000}`.

DSH does ship `@anthropic-ai/sdk@0.129.0` alongside `openai@7.19.0`, so Anthropic traffic is
possible under other provider configs — but **it is not what this machine is doing today.**

**Correction to the plan.** T10's vertical slice says "gateway terminates an Anthropic Messages
request". That is the wrong first target. **The first adapter must be OpenAI Chat Completions**,
because that is the protocol the intended first supervised target actually speaks. Anthropic
Messages moves to second. This does not contradict locked decision D3 (all three protocols are
still in scope for v1); it only reorders the work. `lead` will amend T10 accordingly.

Also note the content-block type names DSH normalises to internally: `reasoning`, `text`,
`tool-call` — **not** Anthropic's `thinking`. Whatever normalised transcript type T8 defines
should expect `reasoning` as a first-class block kind, because that is what a real harness emits.

---

## 4. DSH's stream is already content-block-granular  → strong support for T3(e)

Stream events recorded inside `assistant/message.data.stream`:

```
block-start: 76   reasoning-chunks: 25   text-chunks: 9   tool-call-chunks: 42
block-end: 73     usage: 24              finish: 24
```

with chunk shape `{"type":"block-start","index":0,"blockType":"reasoning"}`.

This matters a great deal for **T3**. My proposal was content-block-granular buffering (option e)
plus tool-use gating (option d). DSH — a production harness, independent of this project — has
already converged on exactly that event model: explicit `block-start`/`block-end` framing, a
block `index`, a `blockType`, and per-block-type chunk streams. That is meaningful evidence the
granularity is natural rather than merely convenient, and it means the watcher can reconstruct
block boundaries without parsing provider SSE itself.

It also localises the open question. The thing we still do not know is whether the **upstream
provider** imposes integrity protection on reasoning blocks (signed/checksummed, or required to be
returned unmodified on the next turn). DSH's internal normalisation tells us nothing about that.
Aura's `docs/research/protocol-fidelity.md` remains the authority; this file must not be read as
answering the question.

---

## 5. Cache economics: the empirical case for T4's position  ⚠️ reshapes T4

Aggregate usage across the 24 assistant messages in this session:

| Metric | Value |
|---|---|
| `inputTokens` (uncached prompt) | 159,202 |
| `cacheReadTokens` | 2,482,304 |
| `outputTokens` | 12,466 |
| **Total prompt tokens** | **2,641,506** |
| **Cached share of prompt** | **94.0%** |
| Largest single `inputTokens` | 27,064 |

Two conclusions, both load-bearing:

**(a) Compaction cannot be justified on cost.** 94% of prompt tokens are already served from
cache. The marginal cost of a long context here is roughly 6% of what a naive token count
suggests. Anyone arguing "compact to save money" is arguing against the evidence. This is exactly
the position `lead` took in T4 — trigger on attention signals and noise density, keep token count
as a backstop only — and it now has a number attached.

**(b) Compaction is actively expensive in a way T4 did not price.** Rewriting the middle of a
context invalidates the cached prefix, so a compaction event forfeits a ~2.48 M-token cache
position and forces reprocessing at uncached rates. Compaction is not merely "a rewrite"; it is a
rewrite plus a cache miss on everything after the edit point. The trigger must be considerably
more conservative than "70% of window", and **continuous dedupe/normalisation (T4's cheap
operation) should be strongly preferred** — though note it carries the same cache penalty if it
touches the prefix, so it may need to be restricted to the uncached tail. That is a new question
for T4 and is filed below.

Also worth noting: `usage` and `finish` appear 24 times each while `block-end` appears 73 times
and `block-start` 76 — the counts do not reconcile trivially, so any accounting we build must
tolerate stream records that are partial or interleaved. Do not assume one usage record per
assistant message.

---

## 6. Reproduce

```bash
F=~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
zstd -dc "$F" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const lines=s.split("\n").filter(Boolean).map(JSON.parse);
  const census={};
  for(const l of lines) census[l.type]=(census[l.type]||0)+1;
  console.log(census);
});'
```

Note: `request/header.data.header` deserialises to an **object**, not a JSON string — code that
`JSON.parse`s it unconditionally will throw. Guard with a typeof check.

---

## 7. New questions filed from this recon

- **Q-R1 (for T4).** If prefix edits forfeit the cache, should continuous dedupe/normalisation be
  restricted to the uncached tail only? Or is the attention benefit worth the cache miss? This
  needs a cost model: cache-miss penalty versus measured quality gain. Nobody should guess.
- **Q-R2 (for T1).** Given that the watcher gets session identity for free and the gateway does
  not, should the gateway simply *require* a declared ID and refuse to mutate sessions that lack
  one? That collapses T1's hardest branch into a policy decision.
- **Q-R3 (for T8).** The normalised transcript must represent `reasoning` blocks, `tool-call`
  blocks, per-block stream events with `index`/`blockType`, `usage` including `cacheReadTokens`,
  and provenance back to DSH's `{type,seq,time,data}` envelope. Does the proposed type survive
  contact with this real format, or was it designed against an idealised one?
- **Q-R4 (for T13).** `sandbox/mode` and `approval/policy` carry `source: "delegation"` — meaning
  a parent can impose governance on a child. Observer's own policy model (T9) must not fight that.
  Which wins when Observer's policy is stricter than the harness's, and which wins when it is
  looser?
