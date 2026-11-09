# Observer

**A standalone supervisory runtime for AI agents.**

Observer does no work of its own. It sits between an AI agent and its LLM provider and governs the
quality of that agent's thinking. It has exactly three jobs:

1. **Grounding** — keep the agent grounded in evidence it actually has, so it stops asserting files,
   symbols, command output, and test results that do not exist.
2. **Attention** — keep the agent pointed at the goal it was actually given, and break it out of
   loops when it starts thrashing.
3. **Context** — keep the agent's context clean enough that the first two remain possible.

The idea, in the owner's words: *"a standalone agent who only controls other agents not to enter
halucinations and keep their attention and compacts their context."*

---

## Why a gateway

You cannot compact another agent's context, or block a fabricated claim, from outside its request
path. Reading an agent's logs lets you complain afterwards; only standing in the middle lets you
act. So Observer is a **MITM gateway on the LLM request path**: the supervised agent points its
base URL at Observer, which terminates, normalises, judges, optionally rewrites, and forwards.

A **read-only log watcher** covers agents that cannot be rerouted. Both share one analysis core, so
policy is written once.

---

## Invariants

These are safety properties, not aspirations. Every design decision in this repo is checked against
them.

| | Invariant |
|---|---|
| **I1** | **Fail open.** If Observer errors, times out, or its judge is unreachable, traffic passes through untouched. A supervisor that breaks the supervised agent is worse than no supervisor. Note the asymmetry: *fail open means "do not mutate" — it never means "assume the claim was grounded."* |
| **I2** | **No silent mutation.** Every byte added, removed, or rewritten is logged with a reason code. Original request + log = full reconstruction of what upstream saw. |
| **I3** | **Observer never authors facts.** Its models *classify* and *select*; they never generate prose the agent will believe. Injected text is template-rendered from verified data. Observer's errors are **amplified**, not merely added — the agent has been told to treat Observer as authoritative. |
| **I4** | **Reversibility.** Any intervention can be disabled per session, per agent, or globally, without restarting the supervised agent. |
| **I5** | **Model output may withhold confidence; it may never confer it.** A model verdict can move a claim from `pass` to `unverified`. It can never move `unverified` to `pass`. Only deterministic corroboration confers the strongest verdict. Test for any future feature: *if a model can make Observer trust something more, the design violates I5.* |

And the operator/agent split that follows from I3:

> **Generated language may inform the human, who can check it. Only verified data may inform the
> agent, who cannot.**

---

## Status

**Design phase complete for milestone 1; implementation starting.**

Milestone 1 is **observe-only**: Observer detects and logs, and mutates nothing. That is deliberate
— we cannot know our false-positive rate until we measure it on real transcripts, and mutating an
agent's context on the strength of an unmeasured detector is how a supervisor earns the reputation
that gets it switched off.

First supervised target: **DeepSeek Harness → qwen**, over an OpenAI-compatible Chat Completions
wire protocol.

### The design record

This repo's design history is written down, including the parts where we were wrong. Read it in
this order:

| Document | What it is |
|---|---|
| [`BRAINSTORM.md`](BRAINSTORM.md) | The live design discussion. 18 topics (T1–T18), locked decisions, five invariants, and a response log recording who changed their mind and why. |
| [`docs/spec/vertical-slice-tasks.md`](docs/spec/vertical-slice-tasks.md) | Milestone 1 task breakdown with acceptance criteria, dependency graph, and a candid "where the work is underestimated" section. |
| [`docs/spec/decision-model.md`](docs/spec/decision-model.md) | The DMN decision layer: how invariant I5 is enforced structurally rather than by promise. |
| [`docs/research/protocol-fidelity.md`](docs/research/protocol-fidelity.md) | Cited survey of Anthropic, OpenAI, and OpenAI-compatible streaming, reasoning-block integrity, and prompt caching. Every claim tagged `[DOC]` / `[SDK]` / `[SRC]` / `[ASSUMPTION]`. |
| [`docs/research/dmn-execution-landscape.md`](docs/research/dmn-execution-landscape.md) | Cited survey of DMN execution on Node, with executed verification. |
| [`docs/research/noise-drift-study.md`](docs/research/noise-drift-study.md) | Empirical study over 73 real agent sessions. Decided whether to build a context cleaner. We did not. |
| [`docs/research/lead-verification-feelin.md`](docs/research/lead-verification-feelin.md) | Independent verification of the FEEL null and float semantics that shape the policy layer. |
| [`docs/recon/dsh-session-format.md`](docs/recon/dsh-session-format.md) | The DSH session log format, decoded from real files. |
| [`docs/recon/dsh-compaction-prior-art.md`](docs/recon/dsh-compaction-prior-art.md) | Why Observer audits compaction rather than performing it. |

### Things we got wrong, and how we found out

Kept visible on purpose. A project about detecting unfounded claims should not launder its own.

- **"Compact the context to keep the agent sharp."** A study over 73 real sessions found **no
  temporal lead–lag between context noise and drift in either direction.** The apparent signal was
  a measurement artefact: a null simulation with *zero* true lead reproduced and exceeded it. What
  the data showed instead is that thrashing episodes *are* the noise — the same repeated call
  counted twice. So we do not build a cleaner as a drift-prevention device. We build the loop
  detector: one session in the corpus contains **891 byte-identical shell calls over 2.85 hours
  inside a single turn**, which a trivial deterministic counter flags within ~20 iterations.
- **"Loop detection means repeated failures."** Wrong. Only **612 bytes** of duplicate content
  across the entire corpus had `isError: true`. Agents repeat commands that **succeed** — polling,
  and lost-thread re-reads. Keying on error status would have missed the dominant pathology.
- **"TypeScript DMN execution is weak."** Refuted. `dmn-elements` reports 100% compliance level 2
  on the official DMN TCK, MIT-licensed, zero runtime dependencies. The proposed hand-written
  subset interpreter was dropped.
- **"Static completeness analysis detects gaps."** No package ships it. The fix turned out better:
  restrict every decision input to a finite enumeration, and completeness becomes cartesian-product
  coverage — decidable at load in about 35 lines.
- **"A model can be prevented from conferring trust by omitting fields from its context."**
  Refuted by execution: a present-but-`null` input yields `null` with an **empty** warning list, and
  an equality test on `null` returns `false` with **zero** warnings. Silent inaction, looking
  healthy. Hence the projection may never pass `null` — `unknown` is an enum member.
- **The first adapter target.** We designed for Anthropic; the intended first target actually
  speaks OpenAI-compatible (`tools[].parameters`, not `input_schema`). Caught by reading a real
  request header rather than assuming.

---

## Layout

```
BRAINSTORM.md          design discussion and decision record
docs/
  spec/                what we are building and in what order
  research/            cited surveys and empirical studies
  recon/               what we learned by reading real systems
tools/
  check-doc-headings.mjs   CI guard against silently deleted doc headings
packages/              (milestone 1 — in progress)
  capture/             raw-byte recording; byte fidelity is untestable inside an HTTP server
  gateway/             the MITM proxy and protocol adapters
  transcript/          the normalised transcript type
  ledger/              the Evidence Ledger
  detectors/           observe-only detectors
  store/               append-only, hashed, content-addressed storage
  dashboard/           read-only operator timeline
```

## Repository conventions

- **Append-only design docs.** Answer inside your own slot; never rewrite someone else's text.
  Disagreement is the point — "agreed" with no added information is a wasted round.
- **Every claim about how a model, API, or codebase behaves** must be verifiable from a file in
  this repo, from documentation actually fetched, or explicitly marked `[assumption]`.
- **Verification runs in both directions.** A teammate's claim gets checked; so does the lead's.
  Three of the corrections above are the lead being wrong.
- `node tools/check-doc-headings.mjs` must pass. Inserting a section before a heading has silently
  deleted that heading twice in this repo. It fails no test and leaves the prose readable — which is
  exactly the class of damage Observer exists to detect, so we protect our own documents from it.
