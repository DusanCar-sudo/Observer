# Lead verification: `feelin` null and float semantics

**Author:** `lead`
**Date:** 2026-11-09
**Status:** EXECUTED — `feelin@8.2.0` installed and run on Node 26.13.0, not reasoned about.
Scratch install removed after the run; reproduce with the script in §4.
**Purpose:** aura's round-3 T17 answer refuted a mechanism I proposed for enforcing invariant I5.
A refutation of my own claim gets verified by me before it is accepted or acted on.

---

## 1. All three of aura's measured claims reproduce exactly

| Claim | Executed result | Verdict |
|---|---|---|
| `0.1 + 0.2 = 0.3` evaluates `false` | `value: false`, `warnings.length: 0` | **Confirmed** |
| …because `feelin` uses JS doubles, not FEEL's specified decimal | `0.1 + 0.2` → `0.30000000000000004` | **Confirmed** |
| A **present-but-`null`** input yields `null` with an **empty** warning list | `a > 5` with `{a: null}` → `value: null`, `warnings.length: 0` | **Confirmed** |
| …whereas an **absent** input does warn | `a > 5` with `{}` → `value: null`, `warnings.length: 1` (`NO_VARIABLE_FOUND`) | **Confirmed** |

Consequence, as she argued: **my proposed I5 enforcement mechanism does not work.** I suggested
building the conferral subgraph's synthetic context *without* model-derived fields so that any rule
referencing one would raise `NO_VARIABLE_FOUND`, which her mandatory warning-as-error rule would
promote to a load-time failure. That only detects **absent** keys. The moment the context is built
by spreading or picking from a wider object, or an optional field defaults to `null`, the key is
present, no warning is raised, and the reference goes undetected. **Warning-based detection cannot
carry I5.** Her fix #1 — static identifier extraction from the `lezer-feel` parse tree, asserting
`refs(conferralTable) ⊆ allowlist` — is therefore not "primary, with synthetic evaluation as a
secondary net". See §2: the secondary net has a hole in it.

The float finding also reproduces with a directly relevant instance: `65536 * 0.1` → `6553.6`,
which is exactly the headroom-percentage arithmetic her Q2 answer routes into the projection with
`Math.floor` rather than leaving in FEEL. That routing is correct and now has an executed reason.

---

## 2. A result worse than reported: equality tests on `null` return `false` with **zero** warnings

DMN decision-table input entries are unary tests, and the ones our rules actually need are
**equality** tests against enum members (`verdict = "grounded"`, `leaseState = "active"`). Executed:

| Expression | Context | `value` | `warnings.length` |
|---|---|---:|---:|
| `a = "grounded"` | `{}` (absent) | `false` | **1** |
| `a = "grounded"` | `{a: null}` | `false` | **0** |
| `a = "grounded"` | `{a: "grounded"}` | `true` | 0 |
| `a = null` | `{a: null}` | `true` | 0 |
| `some x in a satisfies x > 1` | `{a: null}` | `null` | **0** |

**The dangerous row is the second.** A present-but-null input in an equality test yields `false`
— a legitimate-looking rule evaluation — with **no warning whatsoever**. So:

- aura's mandatory rule *"assert `warnings.length === 0`"* **does not catch this case**. It is not
  a weaker net than static analysis; for equality-based tables it is **no net at all**.
- The failure chain is: projection passes `null` → every equality rule evaluates `false` → no rule
  matches → the table returns `null` silently (her executed finding) → **the supervisor does
  nothing and looks healthy**. That is the silent-inaction failure T17 named, arriving through a
  path that emits no signal at any stage.
- Quantifiers inherit it: `some x in a satisfies …` over `null` yields `null` with zero warnings,
  so escaping to a `for`/`some`/`every` construct does not help.

**Therefore, elevated from corollary to hard requirement:** her rule *"the projection must never
pass `null` — unknown is an enum member"* is not a style preference or a defensive nicety. It is
**the only mechanism that makes this failure class detectable**, and note that `a = null` returns
`true` cleanly, so an explicit `unknown` enum member is both matchable by a deliberate rule and
distinguishable from every real value. Combined with static identifier extraction, the two
together close the hole; neither alone does.

This also sharpens her Q6 argument beyond how she stated it. She argued a gap must be a build
failure because *a gap and a missing input produce the identical silent `null`*. Executed result:
**a gap, a null input, and an equality test on a null input all produce silent non-match, and the
third produces it with zero warnings.** Three distinct bug classes sharing one undetectable
signature is a stronger case for making gaps fail the build than two.

---

## 3. What this changes in the design

1. **Static identifier extraction is mandatory, not preferred.** Promoted from her fix #1 ordering.
2. **`null` is banned at the projection boundary.** Every input is a total enum with an explicit
   `unknown` member. Enforced by the projection's types *and* checked at load, because a type is a
   promise and this one has already been broken once in this session by me.
3. **The load-time synthetic context must supply every declared input as a non-null enum member**,
   asserting zero warnings *and* zero null results — her fix as written, now with an executed
   justification for the "and zero nulls" half.
4. **Default output entries remain banned** (`DecisionTable.js:88` fires them on no-match regardless
   of hit policy). Given §2, a default entry would convert this entire failure class into a silent
   *action* rather than a silent inaction, which is worse.
5. No arithmetic and no numeric equality in FEEL, ever — confirmed at `0.1 + 0.2 ≠ 0.3`. Numerics
   are bucketed into named integer bands in the projection, per her §5 recommendation.

---

## 4. Reproduce

```bash
mkdir -p .verify && cd .verify
echo '{"name":"verify","private":true,"type":"module"}' > package.json
npm install feelin@8.2.0 --no-audit --no-fund --cache ./.npmcache   # cache must be in-workspace
cat > t.mjs << 'EOF'
import * as F from 'feelin';
const evaluate = F.evaluate ?? F.default;
const t = (e, c) => { const r = evaluate(e, c);
  return `value=${JSON.stringify(r.value)} warnings=${r.warnings.length}` +
    (r.warnings.length ? ` first=${r.warnings[0].type}` : ''); };
console.log('0.1+0.2 = 0.3      ', t('0.1 + 0.2 = 0.3', {}));
console.log('a>5, a null        ', t('a > 5', { a: null }));
console.log('a>5, a absent      ', t('a > 5', {}));
console.log('a="grounded", null ', t('a = "grounded"', { a: null }));
console.log('a="grounded", absnt', t('a = "grounded"', {}));
console.log('a=null, a null     ', t('a = null', { a: null }));
console.log('some x in a, null  ', t('some x in a satisfies x > 1', { a: null }));
EOF
node t.mjs
```

Note for anyone repeating this: the harness sandbox makes `~/.npm` read-only, so `npm install`
fails with `EROFS` unless `--cache` points inside the workspace.
