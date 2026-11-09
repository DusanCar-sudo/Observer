# DMN Decision-Layer Benchmark — Results

**Author:** `aura` · **Date:** 2026-11-09 · **Status:** measured
**Methodology:** fixed in advance in `docs/spec/dmn-benchmark-plan.md` (committed before any run,
per its §9). Reproduce with `pnpm --filter @observer/dmn-conformance bench` and
`pnpm --filter @observer/dmn-conformance test`.
**Headline:** the stock engine is **46× over** the p50 budget. Compiling the tables to direct
lookups at build time brings it **~86× under** budget, with equivalence proven exhaustively.
**This overturns part of my own round-3 recommendation — see §5.**

---

## 1. Environment (disclosed per plan §4)

| | |
|---|---|
| Node | v26.13.0, linux/x64 |
| CPU | AMD Ryzen 7 7735HS with Radeon Graphics, 16 logical |
| `--expose-gc` | yes |
| loadavg at run | 3.90 / 2.89 / 2.73 — **the machine was not idle**; other agents were running |
| engines | `dmn-elements@0.4.1`, `feelin@8.2.0`, `dmn-moddle@12.2.1`, `@bpmn-io/lezer-feel@3.0.1` (exact pins) |

> The non-idle machine inflates the tails. Treat p99/p99.9 as **upper bounds on a busy box**, not as
> clean-machine figures. p50 is comparatively robust. A clean-machine re-run is still owed.

## 2. Workload

Synthetic fixture (`packages/dmn-conformance/fixtures/policy.mjs`), shaped per
`docs/spec/decision-model.md` §4 and Appendix A. **95,863 bytes** of DMN XML · **10 decisions** ·
**19 distinct inputs** · **195 rules**, generated complete and disjoint. Per-decision cell counts
match Appendix A §A.3 exactly (80/4/24/8/8/48/6/10/4/3).

Output values are assigned by a deterministic scoring function, **not** real policy semantics — the
real tables do not exist yet. This measures the engine and the graph shape, not our policy.

## 3. Results

### B1/B2 — evaluation latency, whole decision layer (all 10 decisions, one global context)

| Approach | N | warm-up | mean | p50 | p90 | p99 | p99.9 | max | Budget (p50 ≤ 0.5, p99 ≤ 2) |
|---|---|---|---|---|---|---|---|---|---|
| **engine, stock** | 2,000 | 5,000 | 20.63 | **20.45** | 22.18 | **27.73** | 44.43 | 52.22 | **FAIL / FAIL** |
| engine + memoised FEEL unary tests | 5,000 | 2,000 | 3.88 | **3.67** | 4.72 | **5.78** | 8.25 | 10.35 | **FAIL / FAIL** |
| **compiled lookups (this proposal)** | 200,000 | 20,000 | 0.0061 | **0.0058** | — | **0.0107** | 0.0197 | — | **PASS / PASS** |

All values in **milliseconds**. The stock-engine p50 was measured three times independently across
the three scripts: **20.45, 22.44, 23.08 ms** — consistent within ~13%, so the number is stable and
not an artefact of one unlucky run. Reported in full rather than as the most favourable.

**Speedups:** memoisation 5.6× on p50; compilation **~3,500×** on p50 (20.45 → 0.0058 ms) and
**~2,600×** on p99 (27.73 → 0.0107 ms).

**GC:** zero GC events were observed during the stock-engine sampling window, so the p99.9 of
44.43 ms is *not* a GC artefact — it is engine cost.

### B3 — allocation: **NOT MEASURED**

`heapUsed` fell by 0.41 MB across 2,000 evaluations, i.e. **−212 bytes per evaluation**. A negative
allocation is meaningless; it means GC timing dominated the two snapshots despite forced collection
before and after. Per plan §9.4 I am reporting this as **not measured** rather than presenting a
number I cannot stand behind. Getting it properly needs `v8.getHeapStatistics()` sampling plus
`--trace-gc` correlation, or an allocator-level profiler. It matters because allocation drives the
tail, and the compiled path's only allocation is the key string — which is worth measuring, just not
by this method.

### B4 — bundle load (XML → moddle → `Definition`)

| | Value | Target | Verdict |
|---|---|---|---|
| cold first load | **29.14 ms** | — | includes module init + JIT; not comparable to warm |
| warm p50 (100 loads) | **9.74 ms** | — | |
| warm p99 | **20.21 ms** | ≤ 50 ms | **PASS** |

### B5 — load-time checks

| Check | What it does | p50 | p99 | Verdict vs 50 ms |
|---|---|---|---|---|
| **B5a** static identifier extraction | `lezer-feel` parse of all **218** FEEL cells, collect identifiers, assert conferral allowlist | **1.07 ms** | 7.67 ms | **PASS** |
| **B5b** synthetic full-context eval | all 10 decisions, every input present and non-null; **0 nulls** ✓ | **23.07 ms** | 32.86 ms | **PASS** (marginal) |
| **B5c** gap/overlap product | all **195** cells; **0 gaps, 0 overlaps** ✓ | **377.5 ms** | 400.6 ms (max) | **FAIL — 7.5× over** |

B5a's static extraction found exactly the expected identifiers and correctly flagged the three
model-derived ones (`judgeVerdict`, `judgeConfidence`, `escalationSignal`) as not in the conferral
allowlist — the I5 check works, and it is cheap.

**B5c confirms the prediction in plan §6, and refutes my own Appendix A optimism.** I had written
that 195 cells "makes load-time validation *plausible*" and that §6's prediction was "probably wrong
in absolute terms". It was not: 377 ms is 7.5× the hot-reload target. **Static policy validation
belongs at build time, not at load time.** The bundle should carry a validation receipt (bundle hash
+ engine versions + checks passed), and runtime load should verify the receipt rather than
re-derive it.

### Compile cost

Compiling all 10 tables by exhaustion — **195 engine calls** — took **564.5 ms**. That is a build-time
cost and is acceptable; it is the same order as B5c because it *is* the same enumeration.

---

## 4. Root cause of the stock-engine number

`dmn-elements/src/Expressions.js`:

```js
Expressions.prototype.unaryTest = function evaluateUnaryTest(test, context) {
  const { value, warnings } = unaryTest(test, context);   // ← feelin, with the SOURCE STRING
  this._warn(expression, warnings);
  return value;
};
```

**Every cell of every rule is re-parsed from source on every evaluation.** There is no compiled-form
cache. `feelin` does export `parseExpression` / `parseUnaryTests`, but they return a **Lezer `Tree`**,
not an executable, and no public API evaluates a pre-parsed tree — so caching the parse is not
available from outside.

That is a reasonable design for a BPM engine evaluating a handful of decisions per process. It is
46× too slow to sit on a 15 ms request path evaluated per turn.

Memoising `unaryTest` by `(source, value)` recovers 5.6× (20.45 → 3.67 ms) with **zero semantic
risk** — verified: 300 random contexts × 10 decisions, **0 mismatches** against the stock engine.
But 3.67 ms is still 7× over budget, because the residual is per-rule engine overhead (rule
iteration, output construction, `TraceEntry` allocation, async/callback machinery), not FEEL parsing.

Also confirmed for correctness: `Definition.evaluate` constructs a `new DefinitionExecution(this)`
per call (`src/definition/Definition.js:58`), so its internal memoisation is per-call only. The
benchmark is measuring real work, not cached results.

---

## 5. The architectural conclusion — and where I was wrong

**Compile by exhaustion at build time. The engine is the oracle, not the runtime.**

Because the conformance subset requires **every input to be a finite enumeration**
(`decision-model.md` §2.1), a decision table *is* a finite function. So:

1. Enumerate the full product of each table's declared inputs.
2. Ask `dmn-elements` for the answer at **every** cell — once, at build time.
3. Store the results in a `Map` keyed by the input tuple.
4. At runtime, evaluate by key construction plus one hash lookup per decision. Synchronous. No
   engine, no FEEL, no parsing. **5.8 µs p50.**

**Equivalence is total, not sampled.** All 195 cells were compared engine-vs-compiled:
**195/195 identical, 0 mismatches**, and this is now a CI test
(`test/conformance.test.mjs` → *"agrees with the engine on EVERY cell, exhaustively"*). Because the
domain is finite, that is a proof by exhaustion over the entire input space — a strictly stronger
guarantee than any sampled test could give. Integer inputs are exhaustive *per band*, which is sound
only because the bands are derived from the table's own literals (Appendix A §A.2).

**This is where I was wrong in round 3, and I want it stated plainly.** I argued against lead's
"execute with a narrow TypeScript subset compiled once at load" and recommended running
`dmn-elements` directly, on the grounds that reimplementing an evaluator would forfeit the TCK as an
independent check. **The measurement says the hybrid is right and my recommendation was not:**

- lead's *compile-at-load* instinct was correct — the engine cannot sit on the request path;
- my *don't-reimplement* objection was also correct — and is satisfied, because **we did not write an
  interpreter.** We wrote ~150 lines that enumerate a finite domain and record the engine's answers.
  The engine remains the semantic authority, the TCK remains the anchor on the engine, and the
  compiled artifact is provably equivalent by exhaustion.

Neither of us proposed this. It is only available because of the enum restriction, which has now
earned its keep four times over: completeness decidability, float safety, gap detectability, and
O(1) evaluation.

**It also improves the dependency-risk posture, which was my main objection.** `dmn-elements` is
v0.4.1, pre-1.0, single-maintainer. If it is never on the request path, then a compromised or
behaviourally-changed engine cannot silently change production behaviour — it changes the *compiled
artifact*, which the golden-cell diff and the exhaustive equivalence test catch at build time. That
is strictly safer than running it live, which is what I recommended.

### What must change as a result

1. **Build pipeline gains a compile step.** DMN XML → validate (B5a/B5b/B5c) → compile by exhaustion
   → emit artifact + validation receipt. ~0.6 s. Runtime never parses XML and never loads the engine.
2. **Runtime loads the compiled artifact**, not the bundle. Load cost is a `Map` construction —
   **not measured**; expected sub-millisecond but I have no number and will not guess one.
3. **Hot reload (I4) becomes trivially cheap**, since reload is loading a small JSON/Map artifact.
   B5c's 377 ms no longer blocks it. This resolves open item D6 in the direction the plan predicted.
4. **`decision-model.md` Appendix A needs one amendment:** two-variable `cmp` inputs
   (`labelSetTokens <= budgetCapTokens`) force the runtime key function to re-implement a fragment
   of FEEL — currently whitelisted and compile-time-validated in `src/compile.mjs` (`CMP_OPS`, with
   the expression shape checked to be exactly `lhs op rhs`). **Recommended: move those comparisons
   into the projection** so the policy layer receives a plain boolean and the reimplementation
   disappears. That removes the only place the compiled path duplicates FEEL semantics.
5. **The I5 static identifier check is cheap enough to run at load** (1.07 ms p50), so it does not
   need to move to build time. B5b also fits (23 ms) though marginally.

---

## 6. A hazard found by accident, now pinned as a test

While writing the suite I hit a case where **a rule silently stopped matching, with no error and no
warning**: an `<informationRequirement id="r1">` colliding with a `<rule id="r1">`. Rule 0 matched
normally; rule 1 never did. A table with only that rule worked fine.

For a supervisor this is the worst class of bug: a hand-authored or badly-merged policy file with a
duplicated element id **silently loses rules**, producing silent inaction that no test, no lint, and
no runtime error would catch. Pinned as
`DUPLICATE element ids silently drop rules — no error, no warning` in `test/conformance.test.mjs`.

**Required mitigations:** ids must be generated mechanically (never hand-written), and CI must assert
global id uniqueness across the bundle. Adding a `dmnlint` custom rule for this is cheap and should
be done before anyone hand-authors a table.

This is the same failure *shape* as the FEEL null hazard in Landscape §5A.1 — a silent no-op that
looks like healthy operation — arriving from a completely different direction. It strengthens the
case that **the load-time validation suite, not the runtime, is where policy safety is decided.**

---

## 7. Status of the plan's questions

| # | Question | Answer |
|---|---|---|
| B1 | Evaluation latency, compiled once | **stock 20.45 ms p50; compiled 0.0058 ms p50** |
| B2 | p99 | **stock 27.73 ms; compiled 0.0107 ms** |
| B3 | Allocation | **NOT MEASURED** — method inadequate, see §3 |
| B4 | Bundle load | cold 29.14 ms, warm p99 20.21 ms — **PASS** vs 50 ms |
| B5 | Load-time check cost | B5a 1.07 ms ✓, B5b 23.07 ms ✓, **B5c 377.5 ms ✗ → build time** |
| B6 | Fast enough for a 15 ms request path? | **Stock engine: no, by 46×. Compiled: yes, with ~86× headroom.** |

## 8. Still not measured (plan §8, unchanged)

The real DRD (does not exist); concurrency and GC under parallel sessions; interaction with the
request path (capture, hashing, spool, SSE tee); tail behaviour under production heap pressure;
total process cold start; transfer to the production machine. Plus two new ones: **compiled-artifact
load time**, and **allocation** (§3/B3).

The loadavg of 3.90 during the run means every tail figure here is pessimistic. A clean-machine
re-run should be done before these numbers are used to set a contractual budget — but the *ratios*
(46× over, 86× under) are far outside the noise and will survive it.

---

## 9. Independent second run — corroboration, the column/rule cost curve, and four silent failures

**Author:** `aura` (separate instance, independent fixture and harness) · **Date:** 2026-11-09

Written without sight of §1–§8, then reconciled against them. Its purpose is not to restate the
headline but to (a) corroborate the stock-engine number from a different workload shape, (b) add a
cost curve that says *which* dimension matters, and (c) add four fixture failures that were all
**silent**, which strengthens §6's argument and gives it a concrete gate.

### 9.1 Corroboration of the stock-engine cost

Separate fixture: 10 decisions, 17 deterministic + 3 model-derived inputs, 153 cells, 25 KB XML,
distinct id-generation and a different sampler. Whole-DRD single traversal, 20,000 samples,
2,000 warm-up, seeded interleaving, 100% non-null results:

| | p50 | p99 | p99.9 |
|---|---|---|---|
| This run, whole DRD (one root `evaluate`) | **8.05 ms** | **12.50 ms** | 19.06 ms |
| §3, stock engine | 20.45 ms | 27.73 ms | 44.43 ms |

Same order of magnitude, same verdict, **2.5× apart on p50.** The gap is workload shape, not
disagreement: this fixture averages 20 columns across 10 tables and my sample contexts are drawn
from the same finite enumerations, so a fraction of cells short-circuit early. The §3 number is the
one to quote — it is the more conservative and it was measured three times.

What corroboration buys: the finding does not depend on one fixture's shape. Two independently
built DRDs, two harnesses, both 15–45× over a 0.5 ms budget. **Treat the stock-engine number as
settled.**

### 9.2 The cost curve: columns dominate, rules are nearly free

§4 establishes the mechanism (per-cell re-parse). This isolates the two dimensions, so the
conclusion can be acted on without re-deriving it.

**Vary columns, rules fixed at 4:**

| Columns | p50 | µs per column |
|---|---|---|
| 1 | 0.134 ms | 134 |
| 2 | 0.196 ms | 98 |
| 4 | 0.320 ms | 80 |
| 8 | 0.612 ms | 77 |
| 16 | 1.360 ms | 85 |

**Vary rules, columns fixed at 4:**

| Rules | p50 |
|---|---|
| 3 | 0.312 ms |
| 6 | 0.362 ms |
| 12 | 0.462 ms |
| 24 | 0.663 ms |

**Quadrupling rules (3→12) costs 0.15 ms. Quadrupling columns (4→16) costs 1.04 ms — 7× more.**
Cost is ~80 µs/column (flat, so linear in columns) versus ~15 µs/rule (sub-linear). This is
exactly what §4's per-cell re-parse predicts: work is proportional to *cells actually evaluated*,
and a wide table touches more expressions per rule before the first match.

**Design consequence, independent of the compile decision:** wide tables are the expensive thing.
The DRD as drawn has `injectionPermitted` at 4 columns, and it is the slowest single decision
(0.570 ms p50) — slower than 2-column tables by 2.4×. Narrowing the four widest tables buys ~0.6 ms
per traversal. That is worth having, but it is 7% of the problem; it does not substitute for §5.

### 9.3 Four more silent failures, and the gate that catches all of them

§6 pins one hazard: duplicate element ids silently drop rules. I hit **four more** in a single
fixture, and every one of them produced a *healthy-looking benchmark result* rather than an error.
The first run reported p50 **0.15 ms**, zero GC, and 10,000/10,000 evaluations "succeeding" — while
matching no rule at all.

| Defect | Symptom | Why it was silent |
|---|---|---|
| No `informationRequirement` links on decisions | Inputs never bound | `evaluate()` resolves, binds nothing, returns `null`. Not an exception. |
| No `inputValues` on inputs | Sampler supplied values outside any rule | Same: no match, no error, a very fast no-op. |
| 7 overlapping rules in `UNIQUE` tables | Correctly threw `hit policy violated` | Only surfaced once domains were declared and the product was enumerated — until then the sampler never hit both rules. |
| `"true"` string literal against a boolean value | `protocolCapability: full` never matched | 16 of 24 cells matched; the other 8 returned `null` and inflated nothing visible. |

**The lesson is not "be careful".** It is that the plan's mandatory load-time synthetic
evaluation (§2.2) is *insufficient as specified*, because it asks whether `evaluate()` resolves.
A table that binds no inputs resolves perfectly, fast, every time.

**The gate that catches all five defects** (mine and §6's) is one assertion, and it is cheap:

> For every decision, enumerate the full Cartesian product of its inputs' declared enumerations
> and assert that **every product cell returns a non-null result with no hit-policy violation**.

On this fixture that is 134 cells across 10 decisions and runs in well under a second. It caught
all four of my defects and it would catch §6's duplicate-id case too (a dropped rule turns a cell
that should match into `null`). It is a stronger check than uniqueness because it tests
*behaviour*, not structure — it does not care *why* a rule vanished.

This is the concrete form of plan §6.1 and I recommend it as a hard build gate, not a warning.
Combined with §6: (i) generated ids, (ii) global id-uniqueness assert, (iii) product enumeration
asserting non-null. All three are build-time, all are cheap, and together they close the silent
no-op class.

### 9.4 Where this run differs from §3–§7, and who wins

**B3 (allocation) — same conclusion, reached the same way.** I got −11,671 and +30,370 bytes/eval
on consecutive runs of an identical workload, i.e. noise of both signs. Independently: NOT
MEASURED. Two instances hitting the same wall from different harnesses is evidence the *method* is
wrong, not the machine — a fresh isolate (child process) per batch is required. Agreed with §3.

**B4 (load) — materially different: 4.2 ms p50 / 10.7 ms p99 versus §7's 29.14 ms cold.** Both pass
the 50 ms gate, but a 7× gap is too large to leave unexplained. Most likely causes, in order:
fixture size (mine 25 KB / 153 cells), and §3 records `loadavg 3.90` with other agents running
while mine ran on an otherwise idle machine. **§7's number is the safe one to quote** — it was
measured under adverse conditions, and the gate passes either way. The *conclusion* (hot reload is
affordable, ~1.7× margin even in the bad case) is robust to the discrepancy, which is the part
that matters for I4.

**B1/B2 verdict, and the one thing I would not do.** I agree with §5 completely: compile at build
time, engine as oracle. My independent numbers do not argue for a different conclusion — they
argue the same one from a second direction.

The option I considered and now **withdraw** is the one in my own earlier draft: split the DRD so
only the act-this-turn decisions run synchronously (~1.1 ms p50 across `injectionPermitted` +
`budgetAdmission` + `flipResponse`). That was arithmetic on per-decision timings, and it becomes
irrelevant once §5's compiled lookups put the *whole* DRD at 0.0058 ms. Designing around a
split would add permanent architectural complexity to solve a problem that compilation removes
entirely. **Do not split the DRD.** Recorded here so the reasoning is not silently re-litigated
later.

### 9.5 What this run adds to the plan's status table (§7)

| # | §7 answer | Status after this run |
|---|---|---|
| B1 | stock 20.45 ms; compiled 0.0058 ms | **Confirmed by an independent fixture (8.05 ms).** Verdict unchanged. |
| B2 | stock 27.73 ms; compiled 0.0107 ms | **Confirmed** (12.50 ms). Verdict unchanged. |
| B3 | NOT MEASURED | **Confirmed NOT MEASURED, independently.** Needs child-process-per-batch. |
| B4 | 29.14 ms cold — PASS | **PASS at 4.2 ms; 7× discrepancy unexplained, §9.4.** Still PASS. |
| B5 | B5c 377.5 ms → build time | **Not re-run.** §9.3 proposes a stronger gate than uniqueness. |
| B6 | stock 46× over; compiled ~86× under | **Confirmed for stock. Compilation not re-verified here.** |

Explicitly **not** re-verified by this run: the compiled-lookup path, its ~86× headroom, and the
equivalence proof against the engine oracle. Those remain §5's claims on §5's evidence. My
contribution is that the *problem* is real, quantified, mechanistically explained, and that the
authoring gate is cheap.

