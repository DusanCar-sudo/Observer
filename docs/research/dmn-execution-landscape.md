# DMN Execution Landscape for Node 26 — Cited Survey

**Author:** `aura` · **Date:** 2026-11-09 · **Status:** Round 3 research input (T17 Q1)
**Question:** what can actually evaluate DMN inside a Node 26 process today, at what conformance
level, with what latency and what dependency cost?
**Method:** npm registry metadata and package readmes fetched 2026-11-09 via
`https://registry.npmjs.org/<pkg>`. Every claim is tagged `[REG]` (registry metadata: version,
date, licence, dependencies, unpacked size), `[README]` (package readme text, quoted), or
`[ASSUMPTION]` / `[NOT MEASURED]`.

---

## 0. Verdict

**Lead's assertion that "TypeScript execution is weak" is refuted.** There is a maintained,
MIT-licensed, **zero-runtime-dependency** DMN evaluator for JavaScript that reports **100%
compliance level 2 on the official DMN TCK** (October 2026 run) and already walks the decision
requirement graph and resolves hit policies. `dmn-elements` + `feelin` is the execution strategy.

Consequently **lead's proposed narrow-subset TypeScript interpreter should not be built.** The
*discipline* behind it is right and must be kept — declare a supported subset, reject everything
outside it at load with a clear error — but enforce it as a **validation gate over standard DMN
XML** rather than by reimplementing an evaluator. Reimplementing costs person-weeks, would achieve
worse conformance than the TCK-validated incumbent, and would forfeit the TCK as an independent
check on our own correctness.

`@gorules/zen-engine` should be **rejected**, for a reason that is not quality: it is not a DMN
engine. It evaluates JDM / ZEN policy documents in the ZEN Expression Language. Adopting it means
either abandoning the Human's "use DMN" directive or building and maintaining a lossy DMN→JDM
compiler. It also ships a **27.6 MB** native binary per platform `[REG]`, which harms
"standalone" about as much as a JVM sidecar would.

**One of lead's four DMN justifications is not delivered by any package found.** Static
completeness/gap analysis does not exist in the JS ecosystem; `dmnlint` is a diagram linter
(`label-required` and similar), not a completeness checker. §5 gives the fix: restrict inputs to
**finite enumerations**, where completeness is decidable by exhaustive cartesian product — which
also happens to be exactly the shape of every rule we currently have.

---

## 1. Recommended stack

| Layer | Package | Version / date | Licence | Runtime deps | Size |
|---|---|---|---|---|---|
| DMN evaluation (DRG walk, decision tables, hit policies, boxed expressions) | **`dmn-elements`** | 0.4.1 · 2026-10-17 `[REG]` | MIT | **none** `[REG]` | 174 KB, 43 files `[REG]` |
| FEEL parse + evaluate | **`feelin`** | 8.2.0 · 2026-09-20 `[REG]` | MIT | `min-dash`, `lezer-feel`, `@lezer/common`, `temporal-polyfill` `[REG]` | 390 KB, 14 files `[REG]` |
| DMN XML ↔ model (build/load time, not runtime) | **`dmn-moddle`** | 12.2.1 · 2026-09-21 `[REG]` | MIT | `moddle`, `min-dash`, `moddle-xml` `[REG]` | 103 KB `[REG]` |
| Diagram lint in CI | **`dmnlint`** | 2.0.0 · 2026-10-16 `[REG]` | MIT | `dmn-moddle`, `dmnlint-utils`, `@bpmn-io/lint-core` `[REG]` | 12.7 KB `[REG]` |

Total install footprint is well under 1 MB of pure JavaScript, **no native binaries, no
postinstall scripts, isomorphic and tree-shakeable** `[README]`. Contrast §3.

### 1.1 Conformance, as reported by the package

`dmn-elements` readme, verbatim `[README]`:

> **DMN conformance** — Checked against the [DMN TCK](https://github.com/dmn-tck/tck) (October 2026):
> - **Compliance level 2: 100%** (126/126 assertions)
> - Compliance level 3: 88.6% (3000/3385)
> - Overall: 89.0% (3126/3511)
>
> All boxed expressions of DMN 1.3 evaluate — decision tables, literal expressions, contexts,
> invocations, relations, lists, and function definitions — as do the DMN 1.4 additions
> (conditional, filter, for, some, every; their TCK cases pass in full), plus decision services,
> business knowledge models, item definitions, and multi-model imports. The DMN 1.5 changes are
> covered too… The remaining gap is dominated by FEEL edge-case semantics owned by
> [feelin](https://github.com/nikku/feelin) (arithmetic corner cases, temporal edge cases, range
> equality).

Also `[README]`: *"Executable decision elements based on DMN 1.3, including the DMN 1.4 boxed
expressions (conditional, filter, for, some, every) and the DMN 1.5 item definition… Walks the
decision requirement graph (DRG) and evaluates decisions — decision tables and literal
expressions."* And: *"Sibling of [bpmn-elements](https://github.com/paed01/bpmn-elements), sharing
its idiom: isomorphic, tree-shakeable, minimal runtime dependencies."*

**Hit policies are implemented and observable.** The package's own debug trace `[README]`:

```
dmn-elements:dmn:decisiontable  1 of 2 rules matched: adultRule, resolving hit policy UNIQUE
```

So `U` (Unique) resolution — the property lead's first DMN justification rests on — is real and
already exercised, not something we would have to write.

`dmn-moddle` is described as a **host-side dev dependency** for XML parsing `[README]`, with
`feelin` a **peer dependency**. That split is useful to us: it means the runtime can consume an
already-parsed model, so we can **compile DMN XML → JSON at build time** and ship no XML parser in
the gateway process. That is also the mechanism behind lead's "compiled once at load" requirement,
obtained for free. See `docs/spec/decision-model.md` §5.

### 1.2 The hazard that matters most for a supervisor

`dmn-elements` readme, verbatim `[README]`:

> FEEL evaluation warnings reported by feelin — an unknown variable or context key, an invocation
> of a missing function, invalid built-in arguments — are logged at `warn` level under the `feel`
> scope… **FEEL yields null in these cases without an error**, so this is how a mistyped service or
> variable name surfaces.

`feelin` returns `{value, warnings}` rather than throwing `[README]`:

```javascript
const { value, warnings } = evaluate('x');
// warnings: [{ message: "Variable 'x' not found", type: 'NO_VARIABLE_FOUND', position: {from:0,to:1} }]
```

> **This is a silent-inaction generator, and it is the single most important integration rule in
> this document.** A typo'd variable in a rule condition yields `null`, the unary test fails to
> match, no rule fires, and the supervisor does nothing — while looking healthy. That is precisely
> the failure mode lead identified as the one we fear most.
>
> **Mandatory rule: every FEEL warning is promoted to a load-time or evaluation-time error.** At
> load: evaluate each rule's conditions against a synthetic context containing all declared inputs
> and assert zero warnings. At evaluation: assert `warnings.length === 0` and fail the decision
> (fail-open to `observe` per I1, with a loud finding), never proceed. Do not rely on the `warn`
> log scope; nothing reads logs in production.

`feelin`'s own feature list is honest about its limits `[README]`: full FEEL grammar ✔, context
sensitive incl. names with spaces ✔, recovers on errors ✔, temporal types ✔, built-in functions ✔,
**"Full DMN TCK compliance" ✘** (unchecked box, with a coverage doc). So the 89% overall figure in
§1.1 is bounded by FEEL edge cases, concentrated in *arithmetic corner cases, temporal edge cases,
range equality* `[README]`. **None of those are in our rule set** — our conditions are enum
equality, numeric comparison, and boolean combination — so the residual 11% is largely irrelevant
to us, but that must be *verified per construct we use*, not assumed. Add it to the conformance
subset declaration (spec §3).

---

## 2. Rejected: `@gorules/zen-engine` (Rust + native Node bindings)

`[REG]` v2.1.9, published 2026-10-21, MIT, `github.com/gorules/zen`. Main package 81 KB / 8 files,
with **eight** platform packages declared in both `dependencies` and `optionalDependencies`:
`darwin-x64`, `darwin-arm64`, `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`,
`linux-arm64-musl`, `win32-x64-msvc`, `wasm32-wasip1`.

**Dependency cost, measured from registry metadata `[REG]`:**

| Package | Unpacked size |
|---|---|
| `@gorules/zen-engine-linux-x64-gnu` | **27,572,372 bytes (27.6 MB)**, 4 files, `os:["linux"] cpu:["x64"]` |
| `@gorules/zen-engine-wasm32-wasip1` | **15,903,435 bytes (15.9 MB)**, 10 files |

Compare the entire recommended stack: under 1 MB, no native code.

**Why it is rejected — and it is not quality.** Its readme describes it as a *"cross-platform,
open-source Business Rules Engine (BRE) written in Rust with native Node.js bindings"*, modelling
decisions *"on a visual canvas of decision tables, switches, expressions, functions and reusable
sub-decisions"* or as *"a policy document"*, written in *"the ZEN Expression Language"* `[README]`.
**DMN is never mentioned.** It is JDM/ZEN, a different (and reasonable) formalism. Adopting it
means either dropping the Human's DMN directive or maintaining a DMN→JDM translation layer —
which would be lossy, untested against the TCK, and a permanent maintenance liability, defeating
the entire point of using a standard.

Worth recording because it is genuinely attractive and someone will ask again: v2.0 ships
**"Workspace analysis: static type checking across policies and graphs. Type flow, exhaustiveness
checking, write-conflict detection"**, a **"Pre-compiled engine: decisions are parsed and compiled
once at load"**, and a **"Hardened runtime: out-of-range numbers, arithmetic overflow and malformed
inputs return errors or nulls instead of crashing the process"** `[README]`. Those are exactly the
properties we want — but we must build the first one ourselves anyway (§5), and the other two are
properties of our own load pipeline, which we control.

---

## 3. Rejected: JVM sidecar

Not evaluated in depth; rejected on lead's grounds, which the evidence supports. Any Camunda/Drools
engine requires a JVM. Against T7's **15 ms p50** budget, per-decision IPC (serialise context →
cross process → evaluate → serialise result) adds milliseconds of pure overhead before any
evaluation, plus a second runtime to install, supervise, version-match and fail-open around. It
also breaks the "standalone runtime" framing in §2 of `BRAINSTORM.md` and P2's single-process
deployment assumption. `[ASSUMPTION]` on the specific IPC cost — not measured — but the architectural
objection stands regardless of the number.

---

## 4. Rejected: stale JS options

| Package | Version / date `[REG]` | Why rejected |
|---|---|---|
| `dmn-engine` | 1.0.6 · **2022-08-06** | ~4 years stale. Depends on `js-feel`, `dmn-moddle`, **`googleapis`**, `iso8601-duration` `[REG]`. A Google API client as a transitive dependency of a rules engine is an 8.9 MB install and an unexplained supply-chain surface. |
| `js-feel` | 1.4.7 · **2020-10-07** | ~6 years stale; DMN 1.1-era FEEL. Superseded by `feelin` 8.2.0. |
| `@hbtgmbh/dmn-eval-js` | 1.5.0 · **2019-09-03** | *"Evaluation of DMN 1.1 decision tables, limited to S-FEEL"* `[REG]` — 7 years stale, DMN 1.1 only. Interesting only as precedent that **S-FEEL** is the standard's own name for the narrow subset lead wants (see spec §3). |
| `@floken-io/feel` | 0.0.5 · 2026-11-02 | Brand new (v0.0.5, one week old), Apache-2.0, zero-dep kernel + `temporal-polyfill`, and a genuinely complete FEEL feature list `[README]`. **Watch, do not depend on.** Too young for a safety-critical path. |
| `dmn-js`, `camunda-dmn-js`, `@miragon/dmn-modeler`, `@wemake4u/*` | current | **Modellers, not evaluators.** Confirms that part of lead's assertion: the big, well-funded JS DMN tooling is all *authoring*. `dmn-js` 18.0.3 published 2026-11-09 `[REG]`, `camunda-dmn-js` 4.0.1 published 2026-10-26 `[REG]` — both actively maintained, both irrelevant to execution. Use `dmn-js` in the dashboard for *viewing* DRDs if we want, not in the gateway. |

Also noted, potentially useful for Q6 tooling: `@bpmn-io/lezer-feel` 3.0.1 (2026-06-05) — a
maintained Lezer **grammar** for FEEL, with `Expression` and `UnaryTests` selectable top nodes
`[README]`; `@bpmn-io/feel-analyzer` 0.5.1 (2026-09-08) — *"Static FEEL expression analyzer"*
`[REG]`; `@camunda/feel-builtins` 1.5.0 (2026-10-21); `@emaarco/dmn-js-simulation` 0.4.0 —
*"Simulate DMN decision tables directly in a dmn-js modeler — see which rules match"* `[REG]`.

---

## 5. The gap nobody ships: completeness / overlap analysis

Lead's second justification for DMN was *"static completeness analysis detects gaps"*, on the
grounds that for a supervisor a gap means silent inaction. **No package found provides it.**

- `dmn-elements`: no completeness, gap, or overlap analysis in its readme; the word "gap" appears
  only in the conformance section referring to its own FEEL coverage `[README]`.
- `dmnlint` 2.0.0: a **diagram** linter. Example output is `Element is missing label/name
  label-required`; rules are *"plain functions that check elements of the diagram"*; configurable
  via `.dmnlintrc` with `extends: "dmnlint:recommended"`; supports `--max-warnings=0`; requires
  **Node.js 24 or newer** `[README]`. Useful in CI, and its custom-rule API is the right hook — but
  nothing shipped checks rule coverage.

**This is solvable, and cheaply, by restricting the input domain.** General DMN completeness over
numeric/temporal domains needs interval reasoning or SMT. But if every input is a **finite
enumeration**, completeness is exactly cartesian-product coverage:

```
combinations = Π |domain(inputᵢ)|      →  exhaustive, decidable, trivial to compute
gap      = combinations not matched by any rule
overlap  = combinations matched by >1 rule   (a violation under hit policy U)
```

Every rule we currently have fits this shape: `verdict` (4 values), `evidenceClass` (≈5),
`severity` (4), `protocolCapability` (≈4 regimes), `leaseState` (2), `budgetStatus` (3). Six
enumerated inputs at those cardinalities is a few thousand combinations — exhaustively checkable at
load in well under a second. `[ASSUMPTION]` on the exact cardinalities; the argument does not
depend on them, only on finiteness.

> **Recommendation:** make *"every input to a decision table is a finite enumeration, or an ordered
> numeric with explicitly declared boundary buckets"* a **hard rule of the conformance subset**.
> That single restriction buys us the one DMN property no JS package ships, turns lead's
> "gap is a build failure" from an aspiration into ~100 lines of our own code, and simultaneously
> makes rule-coverage-driven test generation (Q6) mechanical: enumerate the product, assert each
> cell has an expected action, and any cell without a test is a coverage hole.
>
> Numeric inputs that genuinely need ranges (token counts, ρ, latency) must be **bucketed into
> named enum bands at the projection boundary**, not compared inside FEEL. That keeps completeness
> decidable *and* keeps the arithmetic that `feelin` is weakest at (§1.2) out of the policy layer
> entirely.

---

## 6. What is not known and must be measured

| # | Unknown | Why it matters | How to resolve |
|---|---|---|---|
| L1 | **Evaluation latency** of `dmn-elements` on our DRD size | T7's budget is 15 ms p50 / 40 ms p99 for the whole pass-through path; the decision layer gets a slice of it. **Not measured — I have no number and will not invent one.** | Benchmark task: compile the real DRD once, evaluate 10⁵ times against representative contexts, report p50/p99 and allocation. Gate CI on a budget. |
| L2 | **Load/compile time** for the full policy set | Determines whether hot reload (I4, Q7) is viable mid-session | Measure XML→moddle→compiled-model time; target < 50 ms so reload is free |
| L3 | Behaviour of `dmn-elements` under a **malformed or hostile** DMN document | Policy files become an attack surface if operators can edit them | Fuzz the loader; assert it rejects rather than partially evaluates |
| L4 | **v0.4.1 stability risk** — pre-1.0, 43 files, `github.com/zerodep/dmn-elements` `[REG]` | A safety-critical dependency on a young single-maintainer package | See §7 mitigations. Do not paper over this: it is the main risk in the recommendation. |
| L5 | Whether `feelin`'s TCK failures touch any construct we use | The 11% residual could include something we rely on | Enumerate our constructs, run each against `feelin`'s TCK coverage doc |

---

## 7. Risk assessment and mitigations for the recommendation

The honest weak point is **L4**: `dmn-elements` is v0.4.1, published 2026-10-17, with no stated
stability guarantee. Mitigations, in order of value:

1. **MIT licence + zero runtime dependencies = small, forkable audit surface.** 174 KB / 43 files
   with no transitive runtime deps `[REG]` is reviewable in a day, and forking is cheap.
2. **The TCK is an independent oracle.** Because conformance is measured against a public,
   versioned test suite rather than the author's own tests, we can re-validate a fork — or a
   successor, or our own interpreter if we ever must — mechanically. **Run the DMN TCK level-2
   subset in our own CI against the pinned version**, so a supply-chain substitution or a bad
   upgrade fails the build. This is the mitigation that makes the version number acceptable.
3. **Pin exact versions** (`dmn-elements@0.4.1`, `feelin@8.2.0`), no ranges, with a renovate-style
   bump gated on the TCK run.
4. **Vendor the compiled policy model**, not just the XML: if the evaluator disappears, the compiled
   JSON plus our conformance tests still describe the semantics, and a replacement engine can be
   validated against the same golden decisions.
5. **Keep the policy layer's surface narrow enough that replacing the engine is a bounded job.**
   This is the strongest argument for lead's subset discipline, and it survives the rejection of
   lead's subset *interpreter*: if we only use enum inputs, `U`/`P`/`F` hit policies, and a declared
   FEEL operator set, then any conformant engine can replace `dmn-elements` — including a
   hand-written one, later, if we must. **The subset declaration is what makes the dependency
   replaceable; that is its real value, not avoiding a dependency.**
6. `bpmn-elements` — the sibling project by the same author `[README]` — is mature and widely used,
   which is weak but real evidence of maintenance continuity.

---

## 8. Sources

All fetched 2026-11-09 from the npm registry (`https://registry.npmjs.org/<package>`) and the
package readmes it serves.

1. `dmn-elements` — <https://www.npmjs.com/package/dmn-elements> · repo <https://github.com/zerodep/dmn-elements>
2. `feelin` — <https://www.npmjs.com/package/feelin> · repo <https://github.com/nikku/feelin>
3. `dmn-moddle` — <https://www.npmjs.com/package/dmn-moddle> · repo <https://github.com/bpmn-io/dmn-moddle>
4. `dmnlint` — <https://www.npmjs.com/package/dmnlint> · repo <https://github.com/bpmn-io/dmnlint>
5. `@gorules/zen-engine` — <https://www.npmjs.com/package/@gorules/zen-engine> · repo <https://github.com/gorules/zen>
6. `@gorules/zen-engine-linux-x64-gnu`, `@gorules/zen-engine-wasm32-wasip1` — size/platform metadata
7. `@bpmn-io/lezer-feel` — <https://www.npmjs.com/package/@bpmn-io/lezer-feel>
8. `@floken-io/feel` — <https://www.npmjs.com/package/@floken-io/feel>
9. `dmn-engine`, `js-feel`, `@hbtgmbh/dmn-eval-js`, `dmn-js`, `camunda-dmn-js`,
   `@bpmn-io/feel-analyzer`, `@camunda/feel-builtins`, `@emaarco/dmn-js-simulation` — registry metadata
10. DMN TCK — <https://github.com/dmn-tck/tck> (referenced by `dmn-elements`; not independently run
    in this survey — see §7 mitigation 2)
