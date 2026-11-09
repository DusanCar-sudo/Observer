# Recon: DSH compaction is prior art — and it forces a pivot

**Author:** `lead`
**Date:** 2026-11-09
**Status:** GROUNDED — read from the DSH source tree at `/home/dusan/deepseek-harness/`, not from
documentation or memory. File paths and identifier names below are quoted verbatim.
**Companion:** `docs/recon/dsh-session-format.md`

---

## 0. The discovery

The runtime context points at a *packaged* DSH tree (`/opt/deepseek-harness-desktop/resources/app/dsh/`)
containing only `node_modules`. There is also a full **source** tree at `/home/dusan/deepseek-harness/`
with 59 packages. Aura cited `packages/compaction/` in her T1 answer; the citation was verified
before being relied on.

`packages/compaction/` is a group of five sub-packages, ~9,120 lines of TypeScript with tests:

| Sub-package | Contents | Relevance to Observer |
|---|---|---|
| `compaction/` | `brand.ts`, `checkpoint.ts`, `tool-pairing.ts`, `types.ts` | The shared contract seam |
| `compaction-basic/` | `config.ts`, `region.ts`, `summarizer.ts`, `types.ts` | The real pressure-driven backend |
| `compaction-tool-result-pruner/` | `config.ts`, `index.ts`, `types.ts` | **Exactly T4's "continuous dedupe"** |
| `compaction-image-offload/` | `image-offload.ts`, `projection.ts`, `project-message.ts` | Modality-specific reduction |
| `command-compact/` | `index.ts` | Manual `/compact` entry point |

**The consequence is blunt: the agent Observer is meant to supervise already compacts, already
prunes tool results, and already checkpoints.** Observer's third pillar cannot be "implement
compaction". It has to be repositioned.

---

## 1. Tool pairing is a hard constraint Observer must respect

`compaction/src/tool-pairing.ts` computes, for a surface of N sequences, an array of **N+1
booleans** — one per possible cut point — marking which cuts are *balanced*:

```ts
/** Return how one surface event changes the in-progress tool-call count. */
function eventDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}
```

with `BalanceCache { generation, cutBalanced: readonly boolean[], indexBySeq, inProgressToolCalls }`,
and the module doc stating plainly: *"Compaction changes surface positions, so safe cuts are
derived from tool-call/result content in current surface order rather than step markers."*

**Why this matters to us.** You cannot cut a transcript between a `tool-call` and its `tool/result`
— the resulting message array is malformed and the provider rejects it. Any Observer design that
drops, summarises, or reorders content must compute the same balance. This is a **correctness
gate on T3 and T4 that neither topic currently states**, and it is cheap to get right only because
someone already worked out the invariant. `region.ts` imports `toolPairingBalancedAfter` and
`toolPairingBalancedBefore` and uses them to validate a `SurfaceSelection` before acting.

Adopt the vocabulary: **surface** = what the model is about to see; **log** = everything that
happened. Compaction rewrites the surface, never the log.

---

## 2. DSH compaction is already lossless-by-reference

`compaction/src/types.ts` describes the replaced range as **shadowed**, not deleted:

```ts
shadowedRange: { start: SessionSeq; end: SessionSeq }
shadowedSeqs: SessionSeq[]
/** Heuristic price of the shadowed content under the token-meter's fixed estimator. */
shadowedTokenCount: number
```

The originals remain in the append-only `session.v4.jsonl.zstd`; only the surface is rewritten.
`checkpoint.ts` then correlates the seam:

```ts
const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'compact-checkpoint' } as const)
export type CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & {
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
}
```

and the summary is injected as a **user message** carrying that source (`region.ts`:
`checkpointMessage: UserMessage`).

**This validates T4's central design claim and removes most of its implementation burden.**
"Lossless-by-reference" is not something Observer must invent — it is the incumbent behaviour.
What Observer can add is the part that is *missing*: nothing here verifies that the summary is
**entailed by** what it shadowed. `summarizer.ts` frames a summary and `region.ts` prices the
shrink, but the correctness of the summary's *content* is trusted, not checked. That gap is
exactly T6's fear, sitting in production code.

---

## 3. The pruner is deterministic, character-based, and already tuned

`compaction-tool-result-pruner/src/config.ts`:

```ts
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})
```

Head+tail retention with a marker for the removed middle, counted in **Unicode code points**
(`codePointLength` — "without splitting surrogate pairs"). No model call. Documented as
"low-friction defaults for coding-agent tool output".

This *is* T4's cheap continuous operation, shipped. Two conclusions:

- Observer should **not** reimplement it. Re-pruning an already-pruned result is at best a no-op
  and at worst destroys the head/tail the harness deliberately kept.
- Its parameters are a **free baseline** for our own noise-density formula. If 8192 chars is the
  incumbent threshold for "this tool output is too long", T4's noise density should be calibrated
  against that, not invented independently.

---

## 4. DSH's compaction trigger is pressure-based, at 0.8

`compaction-basic/src/types.ts`:

```ts
/** Window fraction for pressure; capped at context window minus reserved output and
 *  `headroomTokens`. Defaults to `0.8`. */
thresholdRatio?: number
/** Additional pressure headroom beyond the routed output reservation. Defaults to `65536`. */
headroomTokens?: number
/** Recent context retained as a fraction of context window minus reserved output tokens.
 *  Defaults to `0.16`. */
retainRatio?: number
compactionRetries?: number   // default 1
maxOverflowRetries?: number  // default 1
```

with `auto?: boolean` defaulting to `true` — "automatic step-boundary pressure and
overflow-recovery listeners". Summarisation may use a **separate model**
(`summarizationProvider` / `summarizationModel`) and is tagged with its own request purpose
(`LlmRequestPurposeMap { compaction: true }`).

So: the harness compacts at 80% of window, retains 16% verbatim, retries once, and recovers from
overflow. **My T4 position ("trigger on attention, not token count") is now in direct tension with
an incumbent that triggers on tokens at 0.8.** That is not a refutation — the harness optimises
for *overflow avoidance*, which is a legitimate and different goal — but it means two controllers
would be acting on the same surface.

---

## 5. The pivot: Observer should audit compaction, not perform it

Everything above points one way. Reposition pillar 3:

> **Observer is a compaction *auditor*, not a compactor.**

When the supervised harness compacts, Observer — which sees both the pre-compaction surface and
the post-compaction surface, because it sits on the request path — is uniquely positioned to
verify what no one currently verifies:

1. **Entailment.** Is every assertion in the checkpoint summary actually supported by the shadowed
   range it replaced? This is T6's summary-hallucination check, and it now has a concrete,
   bounded input: `shadowedSeqs` on one side, `checkpointMessage` on the other.
2. **Must-carry survival.** Did the hard constraints, the human's exact requirement words, open
   commitments, and unresolved errors survive into the new surface? T4 asserts a protected set;
   DSH's `retainRatio: 0.16` protects only *recency*, which is not the same thing. A constraint
   stated early and never repeated is precisely what recency-based retention drops.
3. **Tool-pairing legality.** Did the cut land on a balanced position? Cheap, deterministic, and
   a hard failure if wrong.
4. **Shrink honesty.** Does the measured `shadowedTokenCount` against the new summary length
   actually justify the transaction, given that the prefix cache is forfeited (see
   `dsh-session-format.md` §5: 94% of prompt tokens were cache reads)?

For agents with **no** native compaction, Observer may still compact — but then it inherits all
four checks as obligations on itself, and T6 applies at full force.

**Why this is the better product.** It keeps Observer inside its own invariant I3 (never author
facts): auditing is classification, which is what Observer is allowed to do. Compacting is
authoring, which is what gets it into trouble. It also removes the two-controllers-one-surface
conflict in §4, and it turns a pillar that would have competed with a mature 9,120-line
implementation into one that complements it.

---

## 6. Filed as T14 in BRAINSTORM.md

Open questions this raises, all now in the doc:

- **Q-P1.** Does the gateway even *see* a compaction? DSH compacts between steps, so Observer
  observes the surface change from one request to the next — it never receives an event saying
  "compaction happened". Detection must be differential: compare consecutive surfaces and
  recognise the shadow-and-checkpoint signature. Design that.
- **Q-P2.** If the harness compacts at 0.8 and Observer wants to compact for attention at, say,
  0.5, Observer always acts first and the harness's controller never runs. Is that acceptable, or
  must Observer defer to the incumbent? What is the coordination protocol when we do not control
  the other controller?
- **Q-P3.** `shadowedSeqs` are DSH-internal seqs. Observer sees the *wire* transcript, not DSH's
  session surface. Can the shadowed range be reconstructed from wire requests alone, or does the
  audit require the watcher (which does have seqs)? This may decide that **pillar 3 needs the
  watcher, not the gateway** — a significant architectural split.
- **Q-P4.** The pruner's `PRUNE_MARKER` is a recognisable string. Should Observer treat a
  harness-pruned result as *already reduced* and exempt it from noise-density accounting, or does
  a marker-stub still count as noise?
