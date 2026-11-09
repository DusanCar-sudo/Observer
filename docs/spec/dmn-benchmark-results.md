# DMN Decision-Layer Benchmark — Results

**Author:** `aura` · **Date:** 2026-11-09 · **Status:** executed, measured
**Executes:** `docs/spec/dmn-benchmark-plan.md` (written before measurement; not revised after)
**Answers:** L1 (evaluation latency), L2 (bundle load time), and the load-time check cost.

> **Verdict up front: B1 FAILS its gate, on both p50 and p99, in the production shape.**
> The engine is not slow at evaluating rules — it is slow at *walking a wide table*. The fix is
> structural (narrower tables, one traversal instead of ten), not a bigger budget.
> B4 passes with margin. Allocation reporting is suppressed as unreliable (§4).

---

## 1. Environment (mandatory, per plan §4)

| | |
|---|---|
| Node | v26.13.0 |
| CPU | AMD Ryzen 7 7735HS with Radeon Graphics |
| arch / platform | x64 / linux |
| `--expose-gc` | yes on all reported runs |
| Engine pins | `dmn-elements` 0.4.1, `dmn-moddle` 12.2.1 |
| Seed (interleaving order) | 20261109 |
| Warm-up / samples | 5,000 discarded / 100,000 retained (per-decision); 2,000 / 20,000 (whole-DRD, see §3) |
| Other load | none; no other benchmark ran during sampling |

Every number below is machine-specific. Without this table it is not comparable to a re-run.

---

## 2. The fixture, and what it cost me to trust it

Per plan §3.1: synthetic DRD, 10 decisions, 17 deterministic inputs + 3 model-derived, 153 cells,
25 KB of XML. Conformance subset only — `UNIQUE` and `PRIORITY`, no iterators, no boxed logic.

**The first four attempts at this fixture measured nothing, and that is the most useful thing
I found all day.** They reported healthy numbers — p50 0.15 ms, zero GC, all evaluations
"succeeded" — while evaluating rules that never matched. What caught it was asserting a
*non-null result* per evaluation rather than catching exceptions:

| Bug in my fixture | Symptom | Why it silently produced a number |
|---|---|---|
| No `informationRequirement` links | Empty context binding | `evaluate()` resolved, bound nothing, returned `null` — not an exception |
| No `inputValues` | Sampler fed `undefined` | Same: no match, no error, 0.15 ms of nothing |
| 7 overlapping rules in `UNIQUE` tables | Correctly threw `hit policy violated` | Only visible once I declared domains and enumerated the product |
| `"true"` string literal vs boolean value | `full` capability always missed | 16 of 24 cells matched; the rest returned `null` |
| `outputValues` on the table, not the `<output>` | `PRIORITY` rejected on load | Would have failed loudly — but only if I had tested the PRIORITY tables |

**Consequence for the product:** the load-time synthetic evaluation the plan calls mandatory
(§2.2) is not enough. `dmn-elements` returns `null` for a table whose inputs never bind, and it
will do that for a *reachable* decision too. The load check must assert **non-null output on a
known-good vector and a known-bad vector per decision**, not merely that `evaluate()` resolved.
I would make that a hard build gate, not a warning.

---

## 3. L1 — evaluation latency

Two shapes were measured, because they answer different questions and only one is production.

### 3.1 Per-decision calls (B1 as literally specified)

Ten separate `definition.evaluate(decisionId, ctx)` calls, one per decision per sample.
100,000 samples, seeded interleaved order, 5,000 warm-up, 100% non-null results.

| p50 | p90 | p99 | p99.9 | max | mean |
|---|---|---|---|---|---|
| **0.660 ms** | 0.931 ms | **2.38 ms** | 3.15 ms | 16.15 ms | 0.687 ms |

Stable across three runs (p50 0.665 / 0.680 / 0.632; p99 2.38 / 2.41 / 2.30).

**Fails both gates:** p50 0.660 > 0.5 ms, p99 2.38 > 2 ms.

### 3.2 One root call — the production shape

`decision-model.md` §Q4 has a single `decide(baseline, …)` terminal that consumes every branch.
That is *one* `evaluate()` on a root decision whose `informationRequirement`s pull all ten, not ten
calls. Ten calls also each re-resolve the DRG, so §3.1 double-counts resolution.

| p50 | p90 | p99 | p99.9 | max | mean |
|---|---|---|---|---|---|
| **8.05 ms** | 9.88 ms | **12.50 ms** | 19.06 ms | 32.09 ms | 8.40 ms |

20,000 samples (100,000 exceeded a 5-minute budget at ~8 ms each), 2,000 warm-up, 100% non-null.

**This also fails**, and by more: 8.05 ms p50 is 54% of the entire 15 ms request path before
capture, hashing, spooling or the SSE tee are counted.

That §3.1 is *faster per call* than §3.2 is not a contradiction — it is the resolution cost moved,
not removed. Ten calls pay the fixed overhead ten times; one call pays one overhead and ten full
table walks. The DRD costs what it costs.

---

## 4. Why it is slow — the cost is columns, not rules

A fail is only useful with a cause attached, so I swept both dimensions separately.

### 4.1 Column count (rules fixed at 4)

| Columns | Rules | p50 | µs per column |
|---|---|---|---|
| 1 | 4 | 0.134 ms | 134 |
| 2 | 4 | 0.196 ms | 98 |
| 4 | 4 | 0.320 ms | 80 |
| 8 | 4 | 0.612 ms | 77 |
| 16 | 4 | 1.360 ms | 85 |

### 4.2 Rule count (columns fixed at 4)

| Columns | Rules | p50 |
|---|---|---|
| 4 | 3 | 0.312 ms |
| 4 | 6 | 0.362 ms |
| 4 | 12 | 0.462 ms |
| 4 | 24 | 0.663 ms |

**Quadrupling rules (3→12) costs 0.15 ms. Quadrupling columns (4→16) costs 1.04 ms.** A column
costs ~80 µs and is essentially flat; a rule costs ~15 µs and is sub-linear.

~80 µs per column is enormous for what is nominally an expression compile plus a comparison. The
engine appears to compile each `inputEntry` expression per evaluation rather than once at load.
That is a claim about `dmn-elements` internals I have not proven, and I am flagging it as a
**suspicion to verify**, not a finding — the measured fact is only the ~80 µs/column slope.

### 4.3 What this means for the DRD as drawn

`injectionPermitted` has 4 columns and is the slowest single decision (0.570 ms p50). The whole
DRD is 20 columns across 10 tables. Narrowing the wide tables is the only lever that moves p50
materially: dropping from 4 to 2 columns in the four widest tables saves roughly 0.6 ms per
traversal — helpful, but not 8 ms → 0.5 ms.

**No amount of table-shaping makes this fit 15 ms.** The decision count is the problem.

---

## 5. B3 — allocation: reported as unusable, not as a number

Plan §4 asks for bytes/evaluation from `heapUsed` deltas around a 10,000-evaluation batch.
I ran it and got **−11,671 and +30,370 bytes/eval on consecutive runs of the same workload.**
Both are noise. A GC-alive object graph measured through `heapUsed` deltas without a fresh
isolate per batch is not a measurement, and reporting either number as "bytes per evaluation"
would be exactly the bad-number-believed failure the plan warns about.

What I can state without instrumentation: major GCs during the timed batch = **0** in every
reported run (via `PerformanceObserver` on `gc`). So the p99.9 tail is not a GC artifact — it is
genuine evaluation variance, which makes it worse, not better.

**B3 is open.** It needs a fresh-isolate-per-batch harness (`--expose-gc` plus a child process
per batch) and I did not build that this round. Flagging rather than guessing.

---

## 6. L2 - bundle load (B4): passes with margin

XML -> `dmn-moddle.fromXML` -> `new Context` -> `new Definition`, 200 reps.

| p50 | p90 | p99 | max | Gate |
|---|---|---|---|---|
| **4.2 ms** | 7.9 ms | **10.7 ms** | 11.4 ms | <= 50 ms cold, <= 50 ms warm |

~4x margin under the Q7 hot-reload target of 50 ms. **Hot reload is affordable** on this evidence:
a reload costs about one third of a single request budget, so a bundle swap is a visible blip, not
a stall. That is a real answer to I4, and it is the one unambiguously good result here.

---

## 7. Pass / fail, against the gates fixed in the plan

| Check | Gate | Measured | Verdict |
|---|---|---|---|
| B1 p50 | ≤ 0.5 ms | 0.660 (per-decision) / 8.05 (whole DRD) | **FAIL** |
| B1 p99 | ≤ 2 ms | 2.38 / 12.50 | **FAIL** |
| B3 allocation | report a number | not measurable this round | **OPEN** |
| B4 load | ≤ 50 ms | 4.2 p50 / 10.7 p99 | **PASS** |
| B5a+B5b load checks | ≤ 50 ms | not built this round | **OPEN** |
| B5c product enumeration | none (predicted build-time) | confirmed expensive at 153 cells | **PASS (prediction held)** |
| B6 overall | fits the request path? | **No** | **FAIL** |

---

## 8. What the design should do about it

The plan says a fail changes the design, not the budget. Three options, ranked by what they cost
the architecture:

1. **Move the whole decision layer off the request path.** This is already the plan for the LLM
   judge (T7). Extending it to the DMN layer is the smallest change: evaluate after the turn, apply
   on the next. Cost: the mechanism directive for the *current* turn cannot depend on the current
   turn's evidence. That is a real semantic loss, and it is the option I would still take.

2. **Split the DRD.** Only `injectionPermitted`, `budgetAdmission` and `flipResponse` gate an action
   *this* turn. Those are 4, 3 and 2 columns — roughly 0.57 + 0.29 + 0.24 ≈ **1.1 ms p50** for the
   synchronous subset. The other seven become asynchronous. This keeps current-turn gating where it
   matters and fits the path. **This is the option I recommend.**

3. **Shrink the tables to 2 columns and re-measure.** Saves ~0.6 ms per traversal. Not sufficient
   alone; worth doing anyway.

Option 2 needs `lead`'s ratification, not mine — it changes what T7 defers. But it is computable
from the numbers above, which is the point of measuring before deciding.

---

## 9. What this benchmark cannot measure

Restating the plan's §8 limits, now with numbers attached so the gap is concrete:

1. **The real DRD.** This is shape-equivalent, not our tables. When they are authored, B1-B5 must be
   re-run and these numbers superseded.
2. **Concurrency.** Single-threaded. The gateway serves parallel sessions and V8 GC under concurrent
   allocation is materially different. **The 12.5 ms p99 is a floor on the production p99, not an
   estimate of it.** On a shared machine the real number will be worse.
3. **Interaction with the request path.** B1 measures the decision layer alone. Capture, hashing,
   spooling and the SSE tee are not in it. The 15 ms budget covers all of them.

---

## 10. Reproducing this

Harness: `/tmp/obs-bench/` (scratch, not committed — it is a measurement rig, not product code).
`gen.mjs` emits the fixture *and* `domains.json` from one source, so the sampler cannot drift from
the tables — the drift bug in §2 is structurally prevented, not remembered.

```
node gen.mjs        # fixture + domains, from one definition
node overlap.mjs    # exhaustive product enumeration: asserts 0 overlaps, 0 errors
node bench.mjs      # B1 per-decision + B4 load
node bench2.mjs     # B1 whole-DRD (root decision)
```

`overlap.mjs` is the important one. It enumerates the full Cartesian product of every input domain
(134 combinations) and asserts every decision returns a non-null result with no `UNIQUE` violation.
That is the gate that caught all four fixture bugs, and it is the gate I recommend promoting into
`packages/dmn-conformance/` per plan §6.1.

---

## 11. Open items I could not close this round

1. **B3 allocation.** Needs a child process per batch. Unbuilt.
2. **B5a/B5b load-time check cost.** Unbuilt; B4 leaves ~40 ms of the 50 ms budget for them, which
   is likely enough but is not measured.
3. **The ~80 µs/column slope.** Attributing it to per-evaluation expression compilation requires
   reading `dmn-elements` internals. I measured the slope, not the cause, and I am not going to
   report a cause I have not verified.
4. **Whether a narrower DRD really is the answer.** Option 2 in §8 is arithmetic on measured
   per-decision numbers, not a measurement of the split DRD. It should be measured before it is
   designed around.

---

**The headline for `lead`:** the decision layer costs **8.05 ms p50 / 12.50 ms p99** as a single
traversal of the DRD as drawn, against a 15 ms total request budget. It does not fit. The engine is
fine at rules and slow at columns; the DRD is 20 columns wide and 10 decisions deep. Splitting the
synchronous subset (§8 option 2) is the change I recommend, and it is ~1.1 ms — but it needs your
ratification because it moves work T7 assumed was already deferred.

