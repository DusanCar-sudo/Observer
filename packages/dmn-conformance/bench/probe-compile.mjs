import { performance } from 'node:perf_hooks';
import { Context, Definition } from 'dmn-elements';
import { DmnModdle } from 'dmn-moddle';
import { buildPolicyXml, DECISIONS, INPUTS, product, probeValue } from '../fixtures/policy.mjs';

const moddle = new DmnModdle();
const { rootElement } = await moddle.fromXML(buildPolicyXml());
const def = new Definition(new Context(rootElement));

// ── COMPILE BY EXHAUSTION ────────────────────────────────────────────────────
// Legal *only* because every input is a finite enumeration (conformance subset).
// The engine stays the semantic oracle: we ask it every cell once, at load/build
// time, and store the answers in nested Maps. Equivalence is then total, not sampled.
async function compile(def) {
  const tables = new Map();
  let engineCalls = 0;
  for (const d of DECISIONS) {
    const flat = new Map();          // "v1|v2|..." -> output
    for (const combo of product(d)) {
      const ctx = {};
      d.inputs.forEach((name, i) => {
        const idef = INPUTS[name];
        ctx[name] = probeValue(name, combo[i]);
        if (idef.kind === 'cmp') {
          const [lhs, rhs] = idef.expr.match(/[A-Za-z][A-Za-z0-9_]*/g);
          const want = combo[i] === true;
          ctx[lhs] = want ? 1 : 10; ctx[rhs] = want ? 10 : 1;
        }
      });
      const key = combo.map((m, i) => {
        const idef = INPUTS[d.inputs[i]];
        return idef.kind === 'int' ? (m.hi ? '<' : '>=') : String(m);
      }).join('|');
      const r = await def.evaluate(d.id, ctx);
      engineCalls++;
      if (r === null || r === undefined) throw new Error(`GAP in ${d.id} at ${key}`);
      flat.set(key, r);
    }
    tables.set(d.id, flat);
  }
  return { tables, engineCalls };
}

const t0 = performance.now();
const { tables, engineCalls } = await compile(def);
const compileMs = performance.now() - t0;

// Integer inputs need a band resolver at runtime (domains are finite but ints are not)
function keyFor(d, ctx) {
  return d.inputs.map((n) => {
    const idef = INPUTS[n];
    if (idef.kind === 'int') { const at = idef.partition[0]; return ctx[n] < at ? '<' : '>='; }
    if (idef.kind === 'cmp') {
      const [lhs, rhs] = idef.expr.match(/[A-Za-z][A-Za-z0-9_]*/g);
      const op = idef.expr.includes('<=') ? '<=' : '<';
      const r = op === '<=' ? ctx[lhs] <= ctx[rhs] : ctx[lhs] < ctx[rhs];
      return String(r);
    }
    return String(ctx[n]);
  }).join('|');
}
const evalCompiled = (d, ctx) => tables.get(d.id).get(keyFor(d, ctx));

// ── exhaustive equivalence: EVERY cell, not a sample ───────────────────────────
let checked = 0, mism = 0;
for (const d of DECISIONS) for (const combo of product(d)) {
  const ctx = {};
  d.inputs.forEach((name, i) => {
    const idef = INPUTS[name]; ctx[name] = probeValue(name, combo[i]);
    if (idef.kind === 'cmp') { const [l, r] = idef.expr.match(/[A-Za-z][A-Za-z0-9_]*/g);
      const w = combo[i] === true; ctx[l] = w ? 1 : 10; ctx[r] = w ? 10 : 1; }
  });
  const a = await def.evaluate(d.id, ctx);
  const b = evalCompiled(d, ctx);
  checked++;
  if (JSON.stringify(a) !== JSON.stringify(b)) { mism++; if (mism < 4) console.log('MISMATCH', d.id, JSON.stringify(a), JSON.stringify(b)); }
}
console.log(`compile: ${engineCalls} engine calls in ${compileMs.toFixed(1)} ms`);
console.log(`EXHAUSTIVE equivalence: ${checked}/${checked} cells checked, mismatches=${mism} ${mism===0?'✓ total (domain is finite)':'✗'}`);

function ctx() {
  const c = {};
  for (const [n, d] of Object.entries(INPUTS)) {
    if (d.kind === 'enum') c[n] = d.values[(Math.random() * d.values.length) | 0];
    else if (d.kind === 'int') c[n] = Math.random() < 0.5 ? d.partition[0] - 1 : d.partition[0] + 1000;
  }
  c.labelSetTokens = (Math.random()*4000)|0; c.budgetCapTokens = (Math.random()*4000)|0;
  c.replayedInjectionTokens = (Math.random()*4000)|0; c.cumulativeCap = (Math.random()*4000)|0;
  c.permanentCorrections = (Math.random()*20)|0; c.correctionCap = (Math.random()*20)|0;
  return c;
}
async function benchAsync(N, warm) {
  const evalAll = async () => { const c = ctx(); for (const d of DECISIONS) await def.evaluate(d.id, c); };
  for (let i = 0; i < warm; i++) await evalAll();
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++) { const t = performance.now(); await evalAll(); s[i] = performance.now() - t; }
  return Float64Array.from(s).sort();
}
function benchSync(N, warm) {
  const evalAll = () => { const c = ctx(); for (const d of DECISIONS) evalCompiled(d, c); };
  for (let i = 0; i < warm; i++) evalAll();
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++) { const t = performance.now(); evalAll(); s[i] = performance.now() - t; }
  return Float64Array.from(s).sort();
}
const rep = (name, so, budget50, budget99) => {
  const P = p => so[Math.min(so.length-1, Math.floor(p/100*so.length))];
  let sum = 0; for (const v of so) sum += v;
  console.log(`${name.padEnd(22)} N=${String(so.length).padStart(7)} mean ${(sum/so.length).toFixed(5)} p50 ${P(50).toFixed(5)} p99 ${P(99).toFixed(5)} p99.9 ${P(99.9).toFixed(5)} ms  | p50 ${P(50)<=budget50?'PASS':'FAIL'} p99 ${P(99)<=budget99?'PASS':'FAIL'}`);
};
console.log('');
rep('engine (async)', await benchAsync(1000, 500), 0.5, 2);
rep('compiled lookups (sync)', benchSync(200000, 20000), 0.5, 2);
