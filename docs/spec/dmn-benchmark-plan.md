# DMN Decision-Layer Benchmark — Methodology

**Author:** `aura` · **Date:** 2026-11-09 · **Status:** plan, fixed **before** any measurement
**Answers:** `dmn-execution-landscape.md` gaps **L1** (evaluation latency) and **L2** (bundle load
time), plus the load-time check cost `lead` added to scope in round 3.
**Executes in:** `packages/dmn-conformance/` (pinned: `dmn-elements@0.4.1`, `feelin@8.2.0`,
`dmn-moddle@12.2.1`, `@bpmn-io/lezer-feel@3.0.1`, `@lezer/common`).

> **Why this document exists separately from the results.** A benchmark written after seeing the
> numbers is a justification, not a measurement. This fixes the workload, the instrumentation, the
> sample counts, and the pass/fail thresholds in advance, so the results can be read as evidence
> rather than as an argument. Anything here that changes after measurement gets changed visibly,
> with a note saying why.

---

## 1. Questions, and what would answer them

| # | Question | Answers | Blocking |
|---|---|---|---|
| **B1** | How long does one decision-layer evaluation take, with the model compiled once at load? | L1 | Gates the T7 budget split |
| **B2** | What is the **p99**, not the mean? | L1 | A mean inside budget with a p99 outside it is the failure mode that ships |
| **B3** | What does it allocate per evaluation? | L1 | Allocation drives GC, and GC drives the tail |
| **B4** | How long does loading a bundle take — XML → moddle → compiled model? | L2 | Gates whether hot reload can be promised under I4 |
| **B5** | What do the **load-time checks** cost: static identifier extraction over every cell, synthetic full-context evaluation, and the gap/overlap product enumeration? | L2 | Decides whether validation runs at load or at build |
| **B6** | Is `dmn-elements` fast enough to sit on a request path with a 15 ms p50 pass-through budget at all? | all | If not, the decision layer must move off the request path |

---

## 2. Budget, and the slice the decision layer gets

T7's published budget is **< 15 ms added p50, < 40 ms added p99** for the whole pass-through path
when no policy fires. That budget must also cover request capture, incremental hashing, the
write-behind spool, and the SSE tee. The decision layer is pure in-memory computation and should be
a small fraction.

**Proposed allocation — needs `lead`'s ratification, it is not mine to set:**

| | p50 | p99 | Basis |
|---|---|---|---|
| Decision layer (B1/B2) | **≤ 0.5 ms** | **≤ 2 ms** | Pure computation; ~3% of the p50 budget. Anything larger means policy evaluation is competing with I/O for a budget I/O legitimately needs. |
| Bundle load, parse+compile only (B4) | — | **≤ 50 ms** | Matches the Q7 hot-reload target already in `decision-model.md`. |
| Full validation incl. product enumeration (B5) | — | **no runtime budget** | See §6 — my prediction is that this belongs at **build** time, not load time. |

If B1 comes in above 0.5 ms p50 the answer is not "raise the budget". It is either shrink the DRD or
move the decision off the request path (compute asynchronously and apply on the next turn, which is
what T7 already prescribes for the LLM judge).

---

## 3. Workload

### 3.1 The DRD under test

The real policy tables do not exist yet — nobody has authored them. So the benchmark uses a
**synthetic DRD of the shape we plan**, derived from `decision-model.md` §4:

- **10 decisions**, matching the DRD: `groundingBaseline`, `checkerFloor`, `budgetAdmission`,
  `replayAdmission`, `correctionCap`, `injectionPermitted`, `injectionCadence`, `flipResponse`
  (conferral side); `judgeReduction`, `escalationReduce` (reduction side).
- **17 input data elements**, all finite enumerations or integers, per the conformance subset.
- **Hit policies:** `UNIQUE` for the mapping tables, `PRIORITY` with declared `outputValues` for the
  two escalation ladders — the only two the subset permits.
- **Cell count recorded and reported**, because the product-enumeration cost in B5 scales with it and
  the number is meaningless without it.

> **Limitation, stated up front:** this measures a DRD *shaped like* ours, not ours. When the real
> tables are authored, B1–B5 must be re-run against them and the numbers in this plan's results
> superseded. A benchmark against a synthetic workload is evidence about the engine, not about the
> product.

### 3.2 The evaluation contexts

1,000 contexts generated from the **cartesian product of the declared input domains**, sampled
without replacement, so the workload exercises every decision path rather than hammering one hot
path. V8 will otherwise optimise for the shape it sees most and flatter us.

Included deliberately:
- **Hostile contexts** — model-derived fields set to adversarial values (all-`grounded`,
  all-`unavailable`, contradictory verdicts, injection strings). These are the T6 red-team inputs and
  they must be in the latency sample, because a path that only runs under attack still has to be
  fast enough to run.
- **`partialTranscript: true`** and **`leaseState: withheld`** contexts, which short-circuit several
  decisions. Reported separately from the general population, since a workload that is mostly
  short-circuits would understate real cost.

### 3.3 What is compiled once

Per `decision-model.md` and Landscape §5A: `dmn-moddle.fromXML` → `new Context(rootElement)` →
`new Definition(context)` happens **once**, outside the timed loop. Only `definition.evaluate(id, ctx)`
is timed for B1. Timing the parse inside the evaluation loop would measure the wrong thing and
produce a number that looks worse than production.

---

## 4. Instrumentation

- **Clock:** `process.hrtime.bigint()`, nanosecond resolution, monotonic. Not `Date.now()`.
- **Samples:** **100,000** evaluations for B1, all retained (no reservoir sampling), sorted, and
  reported at **p50 / p90 / p99 / p99.9 / max**. p99 over 100k samples has ~1,000 observations
  behind it, which is enough to be stable; p99 over 1,000 samples is noise, and reporting it anyway
  is how bad numbers get believed.
- **Warm-up:** **5,000** discarded iterations before sampling. V8's JIT will otherwise dominate the
  early samples and inflate the tail. The warm-up count is reported alongside the results so a
  reader can judge whether it was enough.
- **Allocation:** `--expose-gc`, then `global.gc()` before and after a fixed batch of 10,000
  evaluations; report `heapUsed` delta / 10,000 as **bytes per evaluation**. Also report
  `external` and `heapTotal` deltas, because a JS-object-heavy workload can move `external` while
  `heapUsed` looks flat.
- **GC interference:** report whether a major GC occurred during the sampling window
  (`perf_hooks` `PerformanceObserver` on `gc`). If it did, the p99.9 is partly a GC number and must
  be labelled as such rather than presented as evaluation cost.
- **Environment disclosure, mandatory:** Node version, `process.arch`/`platform`, CPU model,
  `--expose-gc` presence, whether other load was running, and the git SHA of the policy bundle. These
  numbers are machine-specific; without the environment they are not interpretable and not
  comparable to a re-run.
- **Interleaving:** B1 runs the 1,000 contexts in a **fixed pseudo-random order** (seeded, seed
  recorded), not grouped by decision. Grouped order would warm per-decision caches and flatter the
  result.

---

## 5. Load-time measurements

- **B4 (parse + compile):** `fromXML` → `Context` → `Definition`, timed over **100 iterations** of
  the same bundle, reporting p50/p99. Also report the **cold first load** separately — the first
  `fromXML` pays module initialisation and JIT compilation that later ones do not, and conflating
  them hides the number that actually matters for process start.
- **B5a (static identifier extraction):** parse every FEEL cell with `@bpmn-io/lezer-feel`
  (`UnaryTests` top node for input entries, `Expression` for output entries and `inputExpression`),
  walk the tree collecting identifier nodes, assert the conferral subset ⊆ allowlist. Timed over the
  whole bundle, 100 iterations.
- **B5b (synthetic full-context evaluation):** evaluate every cell with every allowlisted input
  **present and non-null**, asserting zero FEEL warnings and zero null results. Timed as above.
  This is the check that catches both syntax traps in Landscape §5A.2 (`hitPolicy="U"`, unbounded
  intervals like `[32768..)`), so it must run on every load or those become runtime failures.
- **B5c (gap/overlap product enumeration):** the ~35-line checker from `decision-model.md` §6.1 —
  enumerate the cartesian product, evaluate each cell, `null` ⇒ gap, `DecisionError
  /hit policy violated/` ⇒ overlap. Timed over the whole bundle, **10 iterations** (it is expected
  to be the slow one; 100 would waste minutes).

---

## 6. Prediction made in advance, so it can be falsified

**I expect B5c to dominate B4 by one to two orders of magnitude, and I expect it to exceed any
sensible hot-reload budget.**

The product for 17 inputs is astronomically large in the general case; even restricted to the ~6
inputs of a single decision table at 3–5 values each it is thousands of cells *per table*, each
requiring an `evaluate` call. At 10 tables that is plausibly 10⁴–10⁵ evaluations per load.

If that prediction holds, the architectural conclusion is not "make it faster" — it is:

> **All static policy validation runs at build time, in CI, and fails the build. Runtime load does
> only parse + compile.**

That is better on every axis: the checks are properties of the *bundle*, not of the session, so
re-running them on every hot reload recomputes a constant; a build failure is caught by the author
rather than surfacing as a reload that silently skipped validation; and hot reload becomes cheap
enough to promise under I4. The bundle then carries a **validation receipt** — bundle hash plus the
checks that passed and the engine versions they passed against — and runtime load verifies the
receipt matches the bundle hash rather than re-deriving it. A bundle with no valid receipt is
refused, which preserves "fail loudly, or don't claim it".

This is stated before measurement deliberately. If B5c comes in at 20 ms the prediction is wrong and
load-time validation becomes viable, which would be a better outcome — but the number gets reported
either way.

---

## 7. Pass / fail

| Check | Pass condition |
|---|---|
| B1 | p50 ≤ 0.5 ms **and** p99 ≤ 2 ms on the synthetic DRD |
| B3 | bytes/evaluation low enough that 100 evaluations per request do not trigger a major GC within a session — reported as a number, threshold set after seeing it, not before |
| B4 | cold load ≤ 50 ms; warm p99 ≤ 50 ms |
| B5a + B5b | ≤ 50 ms combined — these must stay at load time because they catch per-bundle syntax errors |
| B5c | no runtime budget; expected to move to build time per §6 |
| B6 | overall verdict stated plainly: fits the request path, or does not |

**A fail is a result, not a problem with the benchmark.** If B1 fails, the finding is that a DMN
decision layer cannot sit on a 15 ms path at this DRD size, and the design changes — either fewer
decisions on the request path, or asynchronous evaluation applied next turn.

---

## 8. What this benchmark cannot measure

Stated now, so it is not discovered later or papered over:

1. **The real DRD.** It does not exist. §3.1's synthetic substitute is shape-equivalent, not
   equivalent.
2. **Concurrency.** This is single-threaded. The gateway will serve many parallel sessions, and V8 GC
   behaviour under concurrent allocation is materially different — the p99 measured here is a *floor*
   on the production p99, not an estimate of it.
3. **Interaction with the request path.** B1 measures the decision layer in isolation. The 15 ms
   budget also covers capture, hashing, spooling and the SSE tee; whether the *sum* fits is
   V1/V4's measurement, not this one.
4. **Tail behaviour under heap pressure.** A long-running gateway with a large heap has different GC
   pauses than a fresh benchmark process. p99.9 here is optimistic.
5. **Process cold start.** B4's cold figure is cold *for the bundle*, inside an already-warm Node
   process. Total process start includes module loading for the whole gateway.
6. **Whether the numbers transfer to the production machine.** These are measured on the dev sandbox;
   the environment block in §4 exists so a reader can judge the gap, not to close it.

---

## 9. Anti-gaming rules

Binding on me, recorded here so they can be checked against the results:

1. This methodology is committed **before** any measurement is run. Changes after the fact are
   annotated with the reason, not silently edited.
2. Raw numbers are reported in full — all percentiles, sample counts, warm-up count, environment.
   No summarising a p99 as "sub-millisecond" because the p50 was.
3. **No re-running until a favourable number appears.** One run, reported. If the run is interrupted
   or the environment was contaminated, that is stated and the run is repeated *in full*, not
   cherry-picked.
4. Anything not measured is reported as **not measured**. This is the third time I have been asked for
   numbers I do not have; the answer stays the same.
5. Failures are reported as failures. §7's last line is the operative one.
