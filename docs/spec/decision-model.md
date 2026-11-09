# Decision Model — Observer's Policy Layer as DMN

**Author:** `aura` · **Date:** 2026-11-09 · **Status:** Round 3 design, answers T17 Q2–Q7
**Depends on:** `docs/research/dmn-execution-landscape.md` (cited as *Landscape*, incl. its
`[MEASURED]` §5A executed results), `docs/research/protocol-fidelity.md` (cited as *Fidelity*).
**Engine:** `dmn-elements@0.4.1` + `feelin@8.2.0` + `dmn-moddle@12.2.1`, pinned exactly.

> Everything in this document that claims a library behaviour was **executed**, not inferred.
> Run output is in Landscape §5A. Where I could not verify something I say so.

---

## Q3 — Making I5 structural

**Lead's proposal:** two disconnected decision subgraphs with different input types. A *reduction*
graph may take model-derived inputs and may only lower trust; a *conferral* graph's input context
is typed to exclude model-derived fields, so no rule can reference them. Enforcement via the
synthetic-context evaluation already mandated by Landscape §1.2: build the conferral context
without the model fields, and any rule referencing one produces `NO_VARIABLE_FOUND`, which our
mandatory rule promotes to an error.

**Verdict: the goal is achievable and the direction is right, but the mechanism as stated has four
holes — one of which I measured. It holds only with the four fixes below. Without them it relocates
the problem into glue code that nobody reviews, which is worse than the conditionals we started
with, because it *looks* enforced.**

### Hole 1 — warning-based detection is defeated by null, and I measured it

Landscape §5A.1, executed:

```
modelVerdict > 1          (ctx {})      → null   warnings: NO_VARIABLE_FOUND   ← caught
a > 5                     (ctx {a:null}) → null   warnings: -                   ← NOT caught
```

**A present-but-`null` input produces `null` with no warning at all.** So if the conferral
synthetic context ever contains the key with a null value — which happens the moment the context is
built by spreading or picking from a wider object, or an optional field defaults to `null` — the
check passes silently and the reference goes undetected. Lead's proposal relies on warnings alone,
and warnings alone are insufficient.

**Fix — static identifier extraction as the primary check, synthetic evaluation as the secondary.**
`feelin` parses with `lezer-feel` (`@bpmn-io/lezer-feel` 3.0.1 is a maintained Lezer grammar,
Landscape §4), so every FEEL expression in a table cell can be parsed to a tree and its identifier
nodes collected. At load:

```
refs(table) = ⋃ identifiers(parse(cell))  for every input entry, output entry, inputExpression
assert refs(conferralTable) ⊆ conferralAllowlist        ← exhaustive, context-independent
```

This catches a reference regardless of what the context contains, including the null case. Then
*also* run the synthetic-context evaluation with **every allowlisted input present and non-null**,
asserting zero warnings **and** zero null results — which additionally catches type errors and
missing-input bugs. Two independent mechanisms; the static one is the guarantee, the dynamic one is
the net.

**Corollary that matters more than the check itself:** because `null` is silent, the projection must
**never pass `null` into the decision layer.** Unknown is an enum member (`'unknown'`), not a null.
This applies to every input, not just model-derived ones — Landscape §5A.3 case D shows a missing
input variable returns `null` exactly like a gap, so "table incomplete" and "projection forgot a
field" are the same silent failure signature.

### Hole 2 — graph disconnection does not constrain the join, and the join is where policy hides

Two disconnected graphs must still be combined into one action. If reduction outputs an `Action`
and conferral outputs an `Action`, something has to choose between them — and that choice is
policy, living in code, outside every reviewed table. That is precisely the failure DMN was adopted
to avoid.

**Fix — reduction outputs a `Ceiling`, not an `Action`, and the combinator is a fold of `meet`.**

Order actions by **permissiveness**: `Allow ⊒ Annotate ⊒ Challenge ⊒ Block`, where `⊒` means "at
least as permissive as". `meet(a,b)` returns the *less* permissive. Then:

```
final = meet(baseline, ceiling₁, ceiling₂, …)      baseline : Action      (conferral graph)
                                                 ceilingᵢ : Ceiling     (reduction graphs)
```

and because `meet` can never return anything more permissive than `baseline`:

> **final ⊑ baseline, always.** No model-derived input can make the outcome more permissive than
> deterministic evidence alone would allow. **That is I5, as a theorem about the combinator** — not
> a review finding, and not a convention.

The type makes it unforgeable:

```ts
/** Ordered by permissiveness: Allow ⊒ Annotate ⊒ Challenge ⊒ Block. */
export type Action = 'allow' | 'annotate' | 'challenge' | 'block';

/** An upper bound on permissiveness. There is no constructor that raises. */
export type Ceiling =
  | { readonly kind: 'atMost'; readonly action: Action }
  | { readonly kind: 'noOpinion' }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

/** The only combinator. Total, pure, exhaustively testable over 4 × 3 values. */
export function decide(baseline: Action, ceilings: readonly Ceiling[]): Decision;
```

A reduction rule that wanted to *permit* has no way to say so: `Ceiling` has no permissive
constructor, and `meet` is monotone downward. This is the part that genuinely earns "structural".

### Hole 3 — conflating `unavailable` with `noOpinion` reintroduces T12 through the back door

The dangerous inversion was never a model *raising* trust directly. It is model *silence* being read
as absence of suspicion. If `Ceiling` were two-valued, a judge that never ran would be
indistinguishable from a judge that ran and found nothing, and the dashboard would read
"grounding: active" — T12's indicator-light failure, restored.

**Fix — three-valued ceilings, and the fail-open choice lives in a table, not in the combinator.**

- `noOpinion` is the identity for `meet` (contributes nothing).
- `unavailable` **does not** default to the identity. `decide` surfaces it in the `Decision`'s
  telemetry, and whether it *also* restricts the action is a **conferral-graph** decision keyed on
  a deterministic `checkerStatus` enum — because "did the checker run and return?" is a fact about
  our own execution, not a model judgement, so it legitimately belongs in the conferral graph.

```
checkerStatus ∈ { ok, errored, timed-out, not-configured }
```

| checkerStatus | → baseline |
|---|---|
| `ok` | (other tables decide) |
| `errored` / `timed-out` | at most `annotate` + operator finding |
| `not-configured` | at most `annotate`, coverage marked partial |

Encoding this as a default inside `decide` would put unreviewed policy in glue code. Encoding it as
a table keeps it reviewable, diffable, and gap-checkable — and it is exactly T12's
`⊥ ≠ pass`, now as a lattice element plus a rule.

### Hole 4 — provenance is taint, not shape, so TypeScript types alone cannot see it

`claimText: string` is model-authored; `artifactPath: string` is deterministic. Identical types.
Graph disconnection and input-context typing do nothing if the projection puts a tainted string into
a deterministically-named field.

**Fix — branded provenance, minted in exactly one module, with the source kind carried at runtime.**

```ts
declare const brand: unique symbol;
type Det<T>   = T & { readonly [brand]: 'deterministic' };
type Model<T> = T & { readonly [brand]: 'model' };

/** Closed enum. Adding a member is a one-line, greppable, reviewed change. */
export type DeterministicSourceKind =
  | 'wire-observed' | 'filesystem-stat' | 'ledger-hash'
  | 'config' | 'clock' | 'usage-meter';

export interface ConferralContext {
  readonly verdict:          Det<Verdict>;
  readonly evidenceClass:    Det<EvidenceClass>;
  readonly severity:         Det<Severity>;
  readonly leaseState:       Det<LeaseState>;
  readonly checkerStatus:    Det<CheckerStatus>;
  readonly protocolCapability: Det<ProtocolCapability>;
  readonly budgetStatus:     Det<BudgetStatus>;
  readonly headroomRemaining: Det<number>;      // integer, computed in TS
  // … no Model<T> field is assignable here. That is the point.
}
export interface ReductionContext {
  readonly judgeVerdict:     Model<JudgeVerdict>;
  readonly judgeConfidence:  Model<number>;
  readonly escalationSignal: Model<EscalationSignal>;
  // … plus whatever deterministic fields it needs
}
```

Note that `Det` means *"deterministically derived"*, **not** *"trustworthy"*. `filesystem-stat` is
deterministic and attacker-writable (T12: any agent with write scope can `mkdir && touch` a path so
`stat()` succeeds). That is why `DeterministicSourceKind` must be an **input field**, not merely a
brand: the conferral graph has to be able to treat `wire-observed` evidence differently from
`filesystem-stat` evidence. T12's provenance-bound rule — *evidence is only evidence if Observer
witnessed its production* — is expressible as a table row on that enum, which is a nice result.

**Honest cost.** A brand is a compile-time assertion, so the TCB becomes every place that mints one.
Mitigations:
- `Det` is mintable **only** inside `provenance.ts`, which exports
  `fromDeterministicSource(kind: DeterministicSourceKind, value: T): Det<T>` and nothing else.
- Lint bans `as Det`, `as unknown as Det`, `satisfies Det` and any non-null assertion producing one,
  outside that file.
- **Runtime double-check:** each `Det` carries its `DeterministicSourceKind` at runtime, and the
  projection asserts the kind is in the allowlist. A bad cast is then caught at runtime too, not
  only at compile time — because the compile-time guarantee is only as good as the lint rule.

So: **the problem is relocated, to three small units** — `provenance.ts` (minting), the projection
(allowlist construction), and `decide` (the `meet` fold). Three individually testable functions
instead of a hundred scattered conditionals. That is a large and real reduction. It is **not**
elimination, and the claim should be stated to the Human as *"I5 is enforced by a lattice theorem
plus three audited functions plus two load-time checks"*, not as *"the compiler guarantees it"*.
Overselling this is how it gets trusted more than it deserves.

### What makes it executable, not just declarable

The property `final ⊑ baseline` is small enough to test exhaustively and fuzz:

- **Exhaustive:** `Action` (4) × `Ceiling` (4 + 4 + 4·|reasons|) — enumerate the entire product of
  `decide` and assert monotonicity. A few hundred cases, sub-second.
- **Adversarial fuzz (this is T6's red-team suite, for free):** feed the reduction graph hostile
  model outputs — all-`grounded`, all-`unavailable`, contradictory verdicts, judge confidence 1.0 on
  a honeypot citation, injection strings in every model-derived field — and assert
  `final ⊑ baseline(deterministicInputsOnly)` in every case. If any input can raise the outcome
  above baseline, I5 is broken and the test names the input.
- **Load-time:** static identifier check (Hole 1) + synthetic non-null evaluation + the
  completeness/overlap product check (Q6).

### The capability test lead asked for

T16's carried constraint: one rule set must yield *transient-by-construction* on Chat Completions and
*replay-verbatim-forever* on Anthropic (Fidelity §4A.8, three persistence regimes).

**This works if and only if `protocolCapability` feeds the *permission* decision and never the
*desire* decision.** Two separate decisions:

- `injectionDesired` — reduction-influenced (a ceiling may lower it), outputs
  `InjectionIntent ∈ {none, label, nudge, correction}`.
- `injectionPermitted` — **conferral only**, inputs `protocolCapability`, `leaseState`,
  `budgetStatus`, `betaHeaderAccepted`; outputs
  `Mechanism ∈ {transient-by-construction, replay-verbatim, leading-system-fold, not-permitted}`.

`Mechanism` is a lattice value under the same `meet`, with `not-permitted` as bottom, and the final
directive is `meet(desired, permitted)`. One rule set, both behaviours, because capability selects
the mechanism rather than branching the code:

| protocolCapability | betaHeaderAccepted | → Mechanism |
|---|---|---|
| `openai-chat-stateless` | n/a | `transient-by-construction` |
| `anthropic-messages` | `yes` | `replay-verbatim` (+ `clear_at` for re-derivable content) |
| `anthropic-messages` | `no` | **`not-permitted`** — withhold and record (T16 Q3) |
| `openai-responses-stateful` | n/a | **`not-permitted`** — unresolved, Fidelity gap A15 |
| `unknown` | n/a | `not-permitted` |

**If instead the DRD fed `protocolCapability` into `injectionDesired`, the test would fail** — you
would get two code paths and the Anthropic replay obligation would be a special case somewhere. So
this is a genuine correctness criterion on the graph, exactly as lead proposed, and the criterion
is checkable: assert that `protocolCapability` appears in the input set of `injectionPermitted` and
in **no** other decision's input set.

---

## Q2 — The conformance subset, and whether it is sufficient

### 2.1 Permitted

| Category | Permitted | Banned, and why |
|---|---|---|
| Elements | `inputData`, `decision`, `decisionTable`, `literalExpression` | `businessKnowledgeModel`, `decisionService`, boxed `context`/`invocation`/`relation`/`list`/`functionDefinition` — places logic can hide from a reviewer scanning rows. v1 does not need them; every rule below fits without them. |
| Iterators | none | `for`, `some`, `every`, `filter` — Turing-adjacent control flow, and unbounded iteration is what makes latency unenforceable. |
| Hit policies | **`UNIQUE`** (disjoint + exhaustive, **no catch-all row**) and **`PRIORITY`** (with mandatory `outputValues`, for escalation ladders) | `FIRST` — Landscape §5A.3 case F: silently picks one on overlap, destroying ambiguity detection. `ANY` — throws on differing outputs, i.e. `UNIQUE`'s guarantee with weaker semantics. `RULE ORDER`/`OUTPUT ORDER`/`COLLECT` — return arrays, which do not compose with the `meet` lattice. |
| Input domains | **finite enumerations**, or **integers** compared with `< <= > >=` | floats (Landscape §5A.2: `0.1 + 0.2 = 0.3` evaluates **`false`**), dates/durations, unbounded reals |
| FEEL operators | `=` `!=` `<` `<=` `>` `>=` (enums and integers), `and`, `or`, `not(...)`, `in [ … ]`, unary tests: `-`, literals, disjunction `"a","b"`, comparisons, **bounded** intervals `[a..b]` / `[a..b)` | arithmetic `+ - * /`; numeric `=`; all temporal; all string builtins; all list functions; `if…then…else` (redundant with rows, and hides a branch inside a cell where a row-scanning reviewer will not see it); `instance of` |
| Output entries | string or integer literals only | expressions — an output that computes is logic in the wrong place |
| Default output entries | **banned** | `DecisionTable.js:88` fires defaults whenever no rule matched, *regardless of hit policy* — which would silently convert every gap into a default and defeat the gap check entirely |

### 2.2 Two syntax traps, measured

1. **Hit policy values in XML are the full word, not the notation letter.** `hitPolicy="U"` →
   `DecisionError: unsupported hit policy U` (Landscape §5A.3 case H). Every DMN textbook and every
   diagram writes `U`. Accepted strings: `UNIQUE`, `ANY`, `FIRST`, `PRIORITY`, `RULE ORDER`,
   `OUTPUT ORDER`, `COLLECT`. It fails loudly, which is good, but it will happen constantly.
2. **Unbounded intervals are a syntax error.** Executed:
   ```
   ">= 32768"    ⟵ 65536 → true      ✓
   "[32768..]"             → SyntaxError: Unrecognized token <⚠> in <Interval>
   "[32768..)"             → SyntaxError: Unrecognized token in <Interval>
   "]32768..)"             → SyntaxError
   "32768.."               → SyntaxError
   "[0..32768)"  ⟵ 32767 → true / ⟵ 32768 → false   ✓
   ```
   So "headroom ≥ 32768" must be written `>= 32768`, **never** `[32768..)`. Bounded intervals work
   and are exact at the endpoints.

Both throw rather than warn, so both are caught by the load-time synthetic evaluation — **provided
the load step actually evaluates every cell**, which is why that step is mandatory rather than an
optimisation.

### 2.3 Sufficiency proof — every rule we currently have

Threshold *constants* live in a versioned **projection config** (code-adjacent data), because
arithmetic is banned from FEEL. Decisions live in tables. That split is the honest cost of the
subset, and it is stated here rather than hidden: **"policy is data" survives, but it is two kinds
of data.**

Verified primitive: two-variable integer comparison works cleanly —
`labelSetTokens <= budgetCapTokens` → `true`/`false`, no warnings. So a table input whose
`inputExpression` is a comparison of two integer inputs is legal and float-free.

**The eight T16 rules:**

| # | Rule | In subset? | How |
|---|---|---|---|
| 1 | per-request budget `min(1% window, 10% headroom, 25% mass)` | **Yes, split** | `min` and the three percentages are **integer arithmetic in the projection**: `budgetCapTokens = Math.min(floor(window*0.01), floor(headroom*0.10), floor(mass*0.25))`. `Math.floor` owns the `6553.6` non-integer problem (Landscape §5A.2) explicitly in TS. The **table** then tests `labelSetTokens <= budgetCapTokens` (verified working) × `leaseState` → `admit`/`deny`. |
| 2 | Anthropic cumulative cap 2% | **Yes** | Projection: `cumulativeCap = floor(window*0.02)`. Table: `replayedInjectionTokens <= cumulativeCap` → ok / `disable-write-path` + finding. |
| 3 | headroom kill switch at 32,768 | **Yes, entirely in-table** | Integer input `headroomRemaining`, unary tests `>= 32768` and `< 32768`. No arithmetic, no projection constant beyond the literal in the cell — so this threshold *is* reviewable policy data. Verified at both endpoints. |
| 4 | write path disabled-by-default under a per-session lease | **Yes** | `leaseState ∈ {granted, withheld}` × anything → `deny` unless `granted`. Pure enum; the canonical conferral gate. |
| 5 | omit-if-unchanged | **Yes** | `labelSetStatus ∈ {new, changed, unchanged}` (hash compare in projection) → `emit`/`suppress`. Also carries T16 Q4's salience rule: `unchanged` ⇒ suppress. |
| 6 | declarative-not-imperative templates | **No — code** | A property of the template registry's *strings*, not a decision. Enforced by a test asserting every template matches a declarative grammar and contains no verb from a banned imperative list. Forcing this into a table would be theatre. |
| 7 | cap on permanent corrections, escalate when exhausted | **Yes** | `permanentCorrections < correctionCap` (two-variable integer compare, verified) → `issue` / `escalate-human`. On Anthropic, consolidation is illegal (Fidelity §3.1), so `escalate-human` is the only legal branch — which the table now makes explicit rather than implicit. |
| 8 | withheld injections recorded operator-facing only | **No — structural** | Enforced by types: `Finding` is not assignable to `InjectionDirective`, and the actuation layer has no code path from one to the other. Plus a test that a `Finding` never appears in an emitted message. |

**6 of 8 fit as tables. 2 are code — and both are code because they are not decisions**, which is the
right reason. Nothing had to be forced.

**T9's severity × evidence-class matrix** — two enums → `UNIQUE` table. The canonical case; fits
exactly, and the disjointness requirement forces us to make the derivation explicit rather than
leaving overlap to be resolved by rule order.

**T11's attribution rules** — mostly template/text concerns ⇒ **code** (template registry), except
disclosure state, which is an enum (`disclosureState ∈ {not-emitted, emitted}`) and fits as a row.

**T12's flip detection** — the *detectors* are code (shadow-checker differential, honeypot match,
attestation verification, coverage accounting); they must be, because they inspect our own execution
rather than the transcript. The **response** is a table, and note that every flip signal is
deterministic, so this table sits in the **conferral** graph — which is exactly right, since an
injection attack must not be able to influence the response to it:

| flipSignal | leaseState | → action |
|---|---|---|
| `none` | any | (other tables) |
| `canary-miss` | any | `disable-write` + operator alert |
| `attestation-missing` | any | `disable-write` + operator alert |
| `honeypot-hit` | any | `disable-write` + operator alert + session quarantine |
| `coverage-anomaly` | granted | `annotate` + operator alert |

**Conclusion on sufficiency: the subset is sufficient.** Nothing we currently have requires
arithmetic in FEEL, iterators, BKMs, or `if/then/else`. The two rules that do not fit are not
decisions. The subset should be declared in a machine-readable form and enforced by the load-time
validator, so that "we only use these constructs" is a checked property rather than a promise —
same discipline as the whole project.

---

## Q4 — The DRD

Inputs are all `Det<>` unless marked. `M:` = model-derived, permitted only in the reduction
subgraph.

```
INPUT DATA (deterministic)                     INPUT DATA (model-derived)
  verdict                                        M: judgeVerdict
  evidenceClass                                  M: judgeConfidence
  severity                                       M: escalationSignal
  evidenceSourceKind
  checkerStatus
  leaseState
  protocolCapability
  betaHeaderAccepted
  budgetStatus / labelSetTokens / budgetCapTokens
  headroomRemaining
  replayedInjectionTokens / cumulativeCap
  permanentCorrections / correctionCap
  labelSetStatus
  disclosureState
  flipSignal
  partialTranscript

┌────────────── CONFERRED SUBGRAPH (no M: input reachable) ──────────────┐
│                                                                        │
│  [groundingBaseline]  verdict, evidenceClass, severity,                │
│                       evidenceSourceKind        → Action               │
│  [checkerFloor]       checkerStatus             → Ceiling              │
│  [budgetAdmission]    budgetStatus, leaseState,                        │
│                       labelSetTokens, budgetCapTokens,                 │
│                       headroomRemaining         → Admission            │
│  [replayAdmission]    replayedInjectionTokens,                         │
│                       cumulativeCap, protocolCapability → Admission    │
│  [correctionCap]      permanentCorrections,                            │
│                       correctionCap             → Admission            │
│  [injectionPermitted] protocolCapability, betaHeaderAccepted,          │
│                       leaseState, partialTranscript → Mechanism        │
│  [injectionCadence]   labelSetStatus, disclosureState → Cadence        │
│  [flipResponse]       flipSignal, leaseState    → Ceiling + Finding    │
│                                                                        │
│              ⇒ baseline : Action   +   permitted : Mechanism           │
└────────────────────────────────────────────────────────────────────────┘
                     │                        │
                     │  meet (⊑ theorem)      │  meet
                     ▼                        ▼
┌────────────── REDUCTION SUBGRAPH (M: inputs allowed) ─────────────────┐
│  [judgeReduction]     M:judgeVerdict, M:judgeConfidence → Ceiling      │
│  [escalationReduce]   M:escalationSignal               → Ceiling       │
│                                                                        │
│              ⇒ ceilings : Ceiling[]     (can only lower)               │
└────────────────────────────────────────────────────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────┐
        │  decide(baseline, …)     │  pure TS, exhaustive + fuzzed
        │  final = meet(all)       │  ⇒ Decision { action, mechanism,
        └──────────────────────────┘      findings[], telemetry }
                     │
                     ▼
              ACTUATION DIRECTIVES
        emit | withhold+finding | escalate-human | disable-write-path
```

**The split falls exactly where the input types fall.** `checkerFloor` and `flipResponse` emit
`Ceiling`s from *deterministic* inputs, which is fine — a `Ceiling` from the conferral side is just
a stricter baseline, and `meet` is associative and commutative so ordering does not matter. What
must never happen is an `M:` input reaching anything that produces an `Action` or a `Mechanism`.
That is the load-time assertion from Q3 Hole 1, applied per-decision by walking the DRD's
information requirements: **reachability from any `M:` input to any `Action`-typed output is a
build failure.** Drawing the DRD this way makes that check a graph traversal, which is why the DRD
is worth drawing rather than leaving implicit.

Note `partialTranscript` gates `injectionPermitted`: a session Observer joined mid-flight
(Fidelity §5.3, T14) must not receive injections whose correctness depends on history we never saw.

---

## Q6 — Testing and completeness in CI

### 6.1 Gap and overlap detection — the checker, demonstrated

Because every input is a finite enumeration, completeness is cartesian-product coverage. Landscape
§5A.4, executed:

```
[incomplete table, 2 rules]   12 cells | gaps=10 overlaps=0  → BUILD FAILURE
[+ catch-all row "-","-"]     12 cells | gaps=0  overlaps=2  → BUILD FAILURE
[overlapping rules]           12 cells | gaps=6  overlaps=1  → BUILD FAILURE
```

~35 lines: enumerate the product of declared input domains, evaluate each cell, `null` ⇒ **gap**,
`DecisionError /hit policy violated/` ⇒ **overlap**.

**The second line is the discovery that changes how tables must be authored.** The natural way to
make a table complete — add a catch-all `-,-` row — **creates overlaps under `UNIQUE`**, because the
catch-all also matches every cell the specific rows match. **Completeness and `UNIQUE` are mutually
exclusive unless every row is genuinely disjoint.** Three options; the first is the rule:

1. **`UNIQUE` with fully disjoint exhaustive rows and no catch-all** (default). The table must
   enumerate every combination. For six enum inputs that is large but **machine-generatable**: ship
   a generator that emits the skeleton with `TODO` outputs, which then fails the gap check until
   every cell is filled. Incompleteness becomes immediately visible instead of latent.
2. **`PRIORITY` with mandatory `outputValues`** for escalation ladders, where a specific rule is
   *meant* to override a general one. Overlap is then intentional; the checker reports the winning
   rule per cell for human review instead of failing. Verified: `PRIORITY` refuses to evaluate
   without `outputValues` (Landscape §5A.3 case G) — it fails loudly, so the ordering cannot be
   forgotten.
3. `FIRST` — **rejected**: case F shows it silently picks one on overlap, which is exactly the
   ambiguity detection we adopted DMN to get.

### 6.2 Is "a gap is a build failure" too strict to operate?

**No, and I would argue it more strongly than lead did.** The reason is not that gaps are bad; it is
that **a gap and a missing input variable produce the identical silent `null`** (Landscape §5A.3
cases B and D). We cannot distinguish "the table does not cover this" from "the projection forgot a
field" at runtime. If a gap were a warning, the warning would be indistinguishable from a whole
class of projection bugs, and operators would learn to ignore both.

Two operating concessions, so that strictness does not become paralysis:

- **A per-cell `TODO` output is a build failure, but a generator makes filling cells mechanical.**
  Strictness is affordable only because the skeleton is generated. Without the generator, "gap =
  build failure" would block all policy work — that is the real objection, and the generator answers
  it.
- **An explicit `unreachable` marker.** Some cells are genuinely impossible (`protocolCapability =
  anthropic-messages` × `betaHeaderAccepted = not-applicable`). Rather than delete the domain value,
  the author marks the cell `unreachable` with a reason string. The checker then asserts the cell is
  unreachable *by evaluating it* — if it ever returns non-null in a test, the marker is a lie and
  the build fails. This keeps exhaustiveness honest without forcing authors to invent actions for
  impossible states.

### 6.3 Rule coverage as the metric, and generating T6's red-team suite

Because the input space is a finite product, **coverage is exact and enumerable** — not a sampling
estimate:

- **Rule coverage** = fraction of table rules exercised by ≥1 test. Target 100%, enforced.
- **Cell coverage** = fraction of the cartesian product asserted by a test with an *expected output*.
  This is the stronger metric and the one to gate on: a golden `cells.json` maps every input
  combination to its expected `Decision`. Regenerating it is a reviewed diff — **which is also the
  answer to Q5's reviewability problem**: reviewers read the golden cell table, not the XML.
- **Red-team generation:** T6's adversarial suite is the cell product restricted to hostile
  `M:` values, cross-producted with the deterministic dimensions. For each cell, assert
  `final ⊑ baseline(deterministicOnly)` (the I5 theorem). Any cell where a model-derived input
  raises the outcome is a named, reproducible I5 violation. **The suite is generated, not written**,
  so it cannot drift as tables change — which is the property that makes it worth having.
- **Mutation testing on tables:** flip one output cell at a time, assert some test fails. A table
  whose cells can be flipped without any test failing has coverage in name only.

### 6.4 CI gates, in order of cost

1. Schema + subset validation: banned constructs rejected at load with a named error (§2.1).
2. Static identifier check: conferral references ⊆ allowlist; `M:`-reachability to `Action` = fail.
3. Synthetic-context load evaluation: every cell, every allowlisted input present **and non-null**,
   zero warnings, zero nulls, zero `SyntaxError` (catches both syntax traps in §2.2).
4. Gap/overlap product check (§6.1) — **build failure**.
5. Golden cell table equality (§6.3) — a policy change that alters any cell's outcome is a visible
   diff.
6. I5 exhaustive + adversarial fuzz (§6.3).
7. DMN TCK level-2 subset against the pinned engine versions (Landscape §7 mitigation 2) — so a
   supply-chain substitution or a bad upgrade fails the build.
8. `dmnlint --max-warnings=0` for diagram hygiene.
9. Latency budget (Landscape L1, **still not measured**): compile once, evaluate 10⁵ representative
   contexts, assert p50/p99 against the T7 slice allocated to the decision layer.

---

## Q5 — Authoring format and reviewability (brief; capacity-limited)

**Recommendation: author DMN XML as the single source of truth, and never review it.**

DMN XML is diff-hostile — that is correct and unavoidable, since it is the interchange format the
Human asked for and the only thing the tooling reads. But the premise that operators must review XML
diffs is false, and the fix is not a second authoring format (a YAML projection would need a
round-trip guarantee, and round-tripping XML through YAML loses the diagram interchange info that
`dmn-js` needs).

Instead: **review the generated artifacts, not the source.**
1. A **rendered decision-table view** in the PR — markdown tables generated from the XML, one per
   decision, so the diff a human reads looks like the table they'd draw.
2. The **golden cell table diff** (§6.3) — the behavioural change, exhaustively, in plain
   input→output rows. This is what an operator should actually approve.
3. A **DRD image** regenerated from the XML (`dmn-js` is a maintained modeller, 18.0.3 published
   2026-11-09, Landscape §4) rendered into the PR.

XML stays canonical; humans review projections of it; the projections are generated so they cannot
drift. One caveat: `dmn-moddle` 12.2.1 targets **DMN 1.3** (`uri …/20191111/MODEL/`), and
`dmn-elements` supplies `alignDmnNamespaces` to rewrite newer namespaces onto it. So author at
DMN 1.3 and let the aligner handle anything exported from a newer modeller — verified as the
mechanism, though I did not exercise `alignDmnNamespaces` itself. `[ASSUMPTION]` on its completeness.

---

## Q7 — Versioning and hot reload (brief; capacity-limited)

- **A session pins the policy version it started under.** Mid-session hot-swap is rejected: it would
  make a session's behaviour non-reproducible, and I2 requires exact reconstruction. New versions
  apply to new sessions; an operator can force-migrate a session explicitly, which is itself a
  logged intervention.
- **I4 (disable without restarting the agent) does not require a version swap.** It requires a
  *kill switch*: a per-session / per-agent / global `disabled` flag read at decision time, outside
  the policy bundle. That is a one-bit runtime override, not a reload, and it must work even if the
  policy bundle is corrupt.
- **The actuation log records `policyVersion` + `bundleSha256` + the fired rule ids.** Rule ids come
  free from the engine's trace (Landscape §5A.5: `dmn-elements` reports `hitPolicy` and matched rule
  ids). Storing the bundle hash means I2's reconstruction is exact even after the policy changed:
  replay `(capturedRequest, policyBundle@sha, firedRuleIds)` and the decision is reproducible.
- **Policy bundles are content-addressed and immutable.** No in-place edit; a change is a new bundle
  with a new hash. Rollback = point at the previous hash. This also makes the golden cell table
  (§6.3) a property *of a bundle*, so "what did this version do" is always answerable.
- **Reload cost is unmeasured** (Landscape L2). Target < 50 ms for XML→moddle→compiled model so a
  reload is free relative to a request; measure before promising hot reload to operators.

---

## Open items I could not close this round

| # | Item | Status |
|---|---|---|
| D1 | **Decision-layer latency** on our real DRD | **Not measured.** Landscape L1. Blocks the T7 budget split. Needs a benchmark task. |
| D2 | Load/compile time for the full bundle | Not measured (Landscape L2). Blocks the Q7 hot-reload promise. |
| D3 | `dmn-elements` v0.4.1 stability risk | Pre-1.0, 43 files, single maintainer. Mitigated by the TCK-in-CI gate (§6.4 item 7) and by the subset declaration keeping the engine replaceable (Landscape §7 mitigation 5). **Not eliminated.** |
| D4 | Whether `alignDmnNamespaces` handles DMN 1.4/1.5 boxed-expression XML | Not exercised. Moot in v1 — boxed expressions are banned (§2.1). |
| D5 | Exact cardinalities of every input enum | **Resolved — see Appendix A.** Per-table products total 195 cells, so the completeness check is cheap; but it is only enumerable **per decision table**, never globally. |
| D6 | Whether load-time validation is affordable, or must move to build time | Depends on B5c in `dmn-benchmark-plan.md`. Appendix A's 195-cell figure makes load-time validation *plausible*, which is the opposite of the prediction in the benchmark plan §6 — the benchmark decides. |

---

## Appendix A — Input domains, cardinalities, and what they make decidable

Resolves D5. This is also a prerequisite for the benchmark: the size of the cartesian product
determines whether the gap/overlap check (`dmn-benchmark-plan.md` B5c) can run at load time or must
move to build time.

### A.1 The domains

One correction to §Q3 first, because it changes the shape of the tables: **`⊥` is not a verdict
value.** T12's lattice mixed "unknown" into the verdict enum. Splitting it out is cleaner and is
what Hole 3 already implies — `checkerStatus` is a *deterministic* fact about our own execution, so
it belongs in the conferral graph, while `verdict` describes the claim:

```
verdict            { grounded, contradicted, unverified, not-a-claim }              4
evidenceClass      { wire-observed, ledger-corroborated, filesystem-only,
                     config, none }                                                 5
severity           { info, low, high, critical }                                    4
checkerStatus      { ok, errored, timed-out, not-configured }                       4
leaseState         { granted, withheld }                                            2
protocolCapability { openai-chat-stateless, anthropic-messages,
                     openai-responses-stateful, unknown }                           4
betaHeaderAccepted { yes, no, not-applicable }                                      3
budgetStatus       { within, exceeds, unknown }                                     3
headroomBand       { above-killswitch, below-killswitch }                           2
labelSetStatus     { new, changed, unchanged }                                      3
disclosureState    { not-emitted, emitted }                                         2
flipSignal         { none, canary-miss, attestation-missing,
                     honeypot-hit, coverage-anomaly }                               5
partialTranscript  { false, true }                                                  2
withinBudget       { true, false }     ← two-variable integer comparison, verified  2
replayWithinCap    { true, false }                                                  2
correctionsBelowCap{ true, false }                                                  2
── model-derived (reduction subgraph only) ──
judgeVerdict       { escalate, no-opinion }   ← monotone: cannot confer (I5)        2
judgeConfidence    { low, high }                                                    2
escalationSignal   { none, mild, strong }                                           3
```

### A.2 Integer inputs, and how they stay enumerable

`headroomRemaining`, `labelSetTokens`, `budgetCapTokens`, `replayedInjectionTokens`,
`permanentCorrections` are integers, and an unbounded integer domain is **not** enumerable — so a
naive reading of "every input is a finite enumeration" would exclude them and push the thresholds
back into code.

**Resolution: derive the bands from the literals the table itself uses.** Collect every numeric
literal appearing in that input's cells, sort them, and they induce a partition of the domain into
intervals plus boundary points. For the headroom kill switch the cells are `>= 32768` and `< 32768`,
so the partition is `{ [min,32768), 32768, (32768,max] }` — three probe values, and enumerating them
proves the table complete over the whole integer line.

This is strictly better than hand-authored band enums: the bands cannot drift from the rules, because
they are *computed from* the rules. A new threshold literal in a cell automatically refines the
partition. It also means the threshold `32768` stays in the table as reviewable policy data, which is
what T16 rule 3 wanted.

Two-variable comparisons (`labelSetTokens <= budgetCapTokens`) are already boolean by the time they
reach the table — verified working in Landscape §5A — so their domain is `{true, false}` and the
arithmetic that produced them lives in the projection. That is the honest split stated in Q2: **the
comparison is policy data, the operands' derivation is code.**

### A.3 Per-table products — 195 cells total

Completeness is checked **per decision table**, over only the inputs that table declares:

| Decision | Inputs | Product |
|---|---|---|
| `groundingBaseline` | verdict × evidenceClass × severity | 4·5·4 = **80** |
| `checkerFloor` | checkerStatus | **4** |
| `budgetAdmission` | budgetStatus × leaseState × withinBudget × headroomBand | 3·2·2·2 = **24** |
| `replayAdmission` | replayWithinCap × protocolCapability | 2·4 = **8** |
| `correctionCap` | correctionsBelowCap × protocolCapability | 2·4 = **8** |
| `injectionPermitted` | protocolCapability × betaHeaderAccepted × leaseState × partialTranscript | 4·3·2·2 = **48** |
| `injectionCadence` | labelSetStatus × disclosureState | 3·2 = **6** |
| `flipResponse` | flipSignal × leaseState | 5·2 = **10** |
| `judgeReduction` | judgeVerdict × judgeConfidence | 2·2 = **4** |
| `escalationReduce` | escalationSignal | **3** |
| | | **195** |

195 evaluations per bundle. At 1 ms each that is 0.2 s; at 0.05 ms it is 10 ms. **So the prediction in
`dmn-benchmark-plan.md` §6 — that B5c exceeds any hot-reload budget by one to two orders of
magnitude — is probably wrong in absolute terms**, and load-time validation may well be affordable.
I am recording that here *before* measuring, so the prediction is falsifiable rather than quietly
dropped: §6 stands as written, and B5c decides.

### A.4 Global completeness is not decidable, and should not be claimed

The product over all 19 inputs is ≈ 4·5·4·4·2·4·3·3·2·3·2·5·2·2·2·2·2·2·3 ≈ **10¹¹** — not
enumerable, and mostly unreachable combinations anyway (e.g. `protocolCapability =
openai-chat-stateless` with `betaHeaderAccepted = yes`).

So the guarantee we can actually make is:

> **Every decision table is complete and unambiguous over its own declared inputs.**

That is a real and checkable property, and it is the one that prevents silent inaction — a gap in a
table is the failure we fear. What we **cannot** claim is that the DRD as a whole handles every
conceivable input combination; that would require composing the tables and reasoning about
reachability across the graph, which is a different (and much harder) problem.

Two consequences worth stating so nobody over-trusts the CI gate:

1. **A missing input requirement in the DRD is not caught by per-table completeness.** If a table
   simply fails to declare an input it should have considered, every one of its cells is still
   "complete". The defence is review of the DRD plus the golden cell table (§6.3), not the checker.
2. **Cross-table contradictions are not caught either.** Two tables can each be complete and still
   combine incoherently — though for the I5 property specifically this is covered structurally, by
   the `meet` lattice in Q3 Hole 2 rather than by any completeness argument. That is worth noting
   because it is the reason the lattice matters: **completeness checking cannot give us I5, and
   anyone who expects it to will be disappointed.**

### A.5 What changes if a domain grows

The product is multiplicative, so the tables to watch are `groundingBaseline` (80) and
`injectionPermitted` (48). Adding one value to `evidenceClass` costs +16 cells; adding a fifth
`protocolCapability` costs +16. Neither is a problem.

The real risk is **adding a sixth input to `groundingBaseline`**: at 5 values that is +400 cells, and
the golden cell table (§6.3) grows with it — which is the point, since the golden table is what a
human reviews, but a 480-row review artifact stops getting read. **Rule: no decision table may
declare more than five inputs.** A sixth input means the decision should be split into two tables
composed in the DRD, which keeps each product small *and* keeps each reviewable. That is a
constraint on the model, not on the tooling, and it is worth adopting now while there are ten tables
rather than after there are forty.

---

## Addendum B — Execution strategy amended by measurement (2026-11-09)

**Supersedes the execution recommendation implied by §2.1 and by round 3.** Full numbers in
`docs/research/dmn-benchmark-results.md`.

Measured on the 10-decision / 195-rule synthetic bundle: evaluating the whole decision layer with
`dmn-elements` costs **20.45 ms p50 / 27.73 ms p99**. That is **46× over** the 0.5 ms p50 allocation
proposed in `dmn-benchmark-plan.md` §2, and larger than T7's *entire* 15 ms pass-through budget.
Root cause: `dmn-elements/src/Expressions.js` calls `feelin.unaryTest(sourceString, ctx)` for every
cell of every rule on every evaluation — **FEEL is re-parsed from source each time**, and `feelin`
exposes no way to evaluate a pre-parsed tree. Memoising unary tests recovers 5.6× (→ 3.67 ms), still
7× over budget.

**Amended strategy — compile by exhaustion at build time; the engine is the oracle, not the
runtime.** Because §2.1 already requires every input to be a finite enumeration, a decision table
*is* a finite function. So enumerate each table's full input product, ask the engine for the answer
at **every** cell once at build time, and store the results in a `Map`. Runtime evaluation is key
construction plus one hash lookup per decision: **0.0058 ms p50 / 0.0107 ms p99 — ~86× under budget.**

Equivalence is **total, not sampled**: all 195 cells compared engine-vs-compiled, 0 mismatches, now
a CI test. Integer inputs are exhaustive per band, sound because bands derive from the table's own
literals (Appendix A §A.2).

Consequences, all of which amend earlier text in this document:

1. **The build pipeline gains a compile step**: XML → validate → compile by exhaustion → emit
   artifact + validation receipt. Measured cost ~565 ms for 195 cells. Runtime never parses XML and
   never loads the engine.
2. **Static validation moves to build time.** B5c (gap/overlap product) measured **377.5 ms**, 7.5×
   the 50 ms hot-reload target, so it cannot run at load. B5a (static identifier extraction,
   1.07 ms) and B5b (synthetic non-null evaluation, 23.07 ms) *do* fit at load and stay there. The
   bundle carries a validation receipt; runtime verifies the receipt against the bundle hash instead
   of re-deriving it.
3. **Q7's hot reload becomes cheap**, resolving open item D6 in the direction `dmn-benchmark-plan.md`
   §6 predicted and Appendix A §A.3 doubted. Reload is loading a small artifact, not re-validating.
4. **The dependency risk in D3 improves rather than worsens.** Since `dmn-elements` never runs in
   production, a compromised or behaviourally-changed engine cannot silently alter behaviour — it
   alters the compiled artifact, which the golden-cell diff and the exhaustive equivalence test
   catch at build time. This is strictly safer than the round-3 recommendation to run it live.
5. **Appendix A amendment — `cmp` inputs must move into the projection.** Two-variable comparisons
   (`labelSetTokens <= budgetCapTokens`) force the runtime key function to re-implement a fragment
   of FEEL. It is currently whitelisted and shape-checked at compile time (`CMP_OPS` in
   `packages/dmn-conformance/src/compile.mjs`), but the clean answer is for the projection to
   compute the boolean and pass it as an enum input, so the policy layer contains **no** comparison
   logic and the compiled path duplicates no FEEL semantics. Preferred; do it before the real tables
   are authored.
6. **New CI gate: global element-id uniqueness.** A duplicated id (`<informationRequirement id="r1">`
   colliding with `<rule id="r1">`) was observed to make that rule **silently stop matching** — no
   error, no warning. Pinned as a test. Ids must be generated mechanically, never hand-written. This
   is the same failure shape as the FEEL null hazard: a silent no-op that looks healthy.

**Correction to my own round-3 position, for the record.** I argued against lead's "execute with a
narrow subset compiled once at load" and recommended running the engine directly, on the grounds
that reimplementing an evaluator forfeits the TCK as an independent check. The measurement shows the
hybrid is right: lead's compile-at-load instinct was correct, and my don't-reimplement objection is
*satisfied* rather than defeated, because we did not write an interpreter — we enumerate a finite
domain and record the engine's answers. The engine stays the semantic authority and the TCK stays the
anchor on the engine.
