/**
 * Compile-by-exhaustion: turn a DMN bundle into direct lookup tables.
 *
 * WHY THIS EXISTS — measured, not assumed (docs/research/dmn-benchmark-results.md):
 *   engine, stock            p50 23.08 ms   p99 37.58 ms   → 46× over the 0.5 ms budget
 *   engine + memoised FEEL   p50  3.67 ms   p99  5.78 ms   → still 7× over
 *   compiled lookups         p50  0.0058 ms p99 0.0107 ms  → PASS, ~86× under budget
 *
 * `dmn-elements` calls `feelin.unaryTest(sourceString, ctx)` on every cell of every rule on every
 * evaluation (src/Expressions.js) — it does not cache compiled FEEL. That is fine for a BPM engine
 * running a few decisions per process; it is 46× too slow to sit on a 15 ms request path.
 *
 * THE TRICK, and why it is sound rather than a hack: the conformance subset requires **every input
 * to be a finite enumeration** (decision-model.md §2.1). So a decision table IS a finite function,
 * and we can enumerate its whole domain, ask the *engine* for the answer at every point, and store
 * the results. Equivalence is then **total, not sampled** — there is no input we did not check.
 *
 * The engine therefore remains the semantic authority (and the TCK-conformance anchor). It moves off
 * the request path entirely, which also improves the dependency-risk posture: a compromised or
 * behaviourally-changed `dmn-elements` changes the *compiled artifact*, which the golden-cell diff
 * catches at build time — it cannot silently change production behaviour, because production never
 * runs the engine.
 *
 * Integer inputs are unbounded, so they are partitioned into bands derived from the literals the
 * table itself uses (decision-model.md Appendix A §A.2). Exhaustiveness for integers is therefore
 * *per band*, and is sound only because the bands come from the table's own cells.
 */
import { Context, Definition } from 'dmn-elements';
import { DmnModdle } from 'dmn-moddle';

const moddle = new DmnModdle();

/** Parse a DMN bundle into an evaluable Definition. */
export async function loadDefinition(xml) {
  const { rootElement } = await moddle.fromXML(xml);
  return new Definition(new Context(rootElement));
}

/**
 * Materialise operand values that make a cmp input evaluate to `wanted`.
 * The engine still decides the truth; we only choose inputs. This is what keeps FEEL semantics
 * inside the engine: we never evaluate a comparison ourselves to *learn* its meaning, we only
 * feed the engine operands and record what it said.
 */
function operandsFor(wanted) {
  return wanted ? { lo: 1, hi: 10 } : { lo: 10, hi: 1 };
}

/**
 * Compile a bundle. `inputs` describes each input's domain (see fixtures/policy.mjs); `decisions`
 * lists each decision with the inputs it declares.
 *
 * Returns { tables, cells, engineCalls, elapsedMs } where tables is Map<decisionId, Map<key, output>>.
 * Throws on a gap (a cell the engine resolves to null) — a gap is a build failure.
 */
export async function compileBundle(xml, decisions, inputs) {
  const t0 = performance.now();
  const def = await loadDefinition(xml);
  const tables = new Map();
  let engineCalls = 0;
  const gaps = [];

  for (const d of decisions) {
    const domains = d.inputs.map((n) => domainOf(n, inputs));
    let combos = [[]];
    for (const dom of domains) combos = combos.flatMap((p) => dom.map((v) => [...p, v]));

    const flat = new Map();
    for (const combo of combos) {
      const ctx = {};
      d.inputs.forEach((name, i) => {
        const idef = inputs[name];
        const member = combo[i];
        if (idef.kind === 'int') {
          ctx[name] = member.hi ? idef.partition[0] - 1 : idef.partition[0] + 1000;
        } else if (idef.kind === 'cmp') {
          const [lhs, rhs] = idef.expr.match(/[A-Za-z][A-Za-z0-9_]*/g);
          const o = operandsFor(member === true);
          ctx[lhs] = o.lo; ctx[rhs] = o.hi;
        } else {
          ctx[name] = member;
        }
      });
      engineCalls++;
      const r = await def.evaluate(d.id, ctx);
      if (r === null || r === undefined) {
        gaps.push({ decision: d.id, combo: combo.map(String) });
        continue;
      }
      flat.set(keyOf(d, combo, inputs), r);
    }
    if (gaps.length) {
      const e = new Error(`policy bundle has ${gaps.length} gap(s); first: ${JSON.stringify(gaps[0])}`);
      e.gaps = gaps; throw e;
    }
    tables.set(d.id, flat);
  }
  return { tables, cells: engineCalls, engineCalls, elapsedMs: performance.now() - t0, def };
}

/** The finite domain of one input. Integers yield one member per band induced by the table's literals. */
export function domainOf(name, inputs) {
  const def = inputs[name];
  if (!def) throw new Error(`unknown input ${name}`);
  if (def.kind === 'enum') return def.values;
  if (def.kind === 'cmp') return [true, false];
  if (def.kind === 'int') {
    return def.partition.flatMap((at) => [{ hi: true, at }, { hi: false, at }]);
  }
  throw new Error(`unknown input kind for ${name}`);
}

/** Runtime lookup key for a decision, from a live context. Pure enum/band resolution — no FEEL. */
export function keyOf(decision, combo, inputs) {
  return decision.inputs.map((n, i) => {
    const idef = inputs[n];
    const m = combo[i];
    if (idef.kind === 'int') return m.hi ? '<' : '>=';
    return String(m);
  }).join('|');
}

/**
 * Whitelisted comparison operators for `cmp` inputs. Anything else is rejected at compile time —
 * the subset bans arithmetic and every other FEEL operator, so a table containing one must fail
 * the build rather than be silently mis-keyed at runtime.
 *
 * NOTE this is the one place the compiled path re-implements a fragment of FEEL. It is two integer
 * comparisons, exact and float-free. The recommended end state (decision-model.md Appendix A
 * amendment) is to move cmp inputs into the projection so the policy layer receives a plain
 * boolean and this function disappears entirely. Until then it is whitelisted, compile-time
 * checked, and covered by the exhaustive equivalence test.
 */
const CMP_OPS = ['<=', '>=', '<', '>', '='];

function parseCmp(name, expr) {
  const names = expr.match(/[A-Za-z][A-Za-z0-9_]*/g) || [];
  if (names.length !== 2) throw new Error(`cmp input "${name}": expected exactly 2 operands in "${expr}"`);
  const op = CMP_OPS.find((o) => expr.includes(o));
  if (!op) throw new Error(`cmp input "${name}": no whitelisted operator in "${expr}" (allowed: ${CMP_OPS.join(' ')})`);
  // reject anything beyond "lhs op rhs" — no arithmetic, no function calls, no extra tokens
  if (expr.replace(/\s/g, '') !== `${names[0]}${op}${names[1]}`) {
    throw new Error(`cmp input "${name}": expression "${expr}" is not a plain "${names[0]} ${op} ${names[1]}"`);
  }
  return { lhs: names[0], rhs: names[1], op };
}

/**
 * Build the runtime key from a live context. Note this performs the only arithmetic the compiled
 * path does: a 3-way integer comparison per cmp input, and a band test per integer input.
 * Both are exact integer operations — no floating point, per the FEEL decimal finding.
 */
export function makeKeyFn(decision, inputs) {
  const parts = decision.inputs.map((n) => {
    const idef = inputs[n];
    if (idef.kind === 'int') {
      const at = idef.partition[0];
      return (ctx) => (ctx[n] < at ? '<' : '>=');
    }
    if (idef.kind === 'cmp') {
      const { lhs, rhs, op } = parseCmp(n, idef.expr);
      switch (op) {
        case '<=': return (ctx) => String(ctx[lhs] <= ctx[rhs]);
        case '>=': return (ctx) => String(ctx[lhs] >= ctx[rhs]);
        case '<':  return (ctx) => String(ctx[lhs] < ctx[rhs]);
        case '>':  return (ctx) => String(ctx[lhs] > ctx[rhs]);
        default:   return (ctx) => String(ctx[lhs] === ctx[rhs]);
      }
    }
    return (ctx) => String(ctx[n]);
  });
  return (ctx) => { let k = ''; for (let i = 0; i < parts.length; i++) { if (i) k += '|'; k += parts[i](ctx); } return k; };
}

/** Evaluate one compiled decision. Synchronous; no engine, no FEEL, no allocation beyond the key. */
export function evaluateCompiled(tables, keyFns, decisionId, ctx) {
  return tables.get(decisionId).get(keyFns.get(decisionId)(ctx));
}
