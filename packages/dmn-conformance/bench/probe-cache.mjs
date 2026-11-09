import { performance } from 'node:perf_hooks';
import { Context, Definition, Environment } from 'dmn-elements';
import { DmnModdle } from 'dmn-moddle';
import * as feelin from 'feelin';
import { buildPolicyXml, DECISIONS, INPUTS } from '../fixtures/policy.mjs';

const xml = buildPolicyXml();
const moddle = new DmnModdle();
const { rootElement } = await moddle.fromXML(xml);

// Baseline: stock expressions (feelin re-parses every cell on every evaluation)
const base = new Definition(new Context(rootElement));

// Cached: same feelin semantics, memoised on (cell source, primitive value).
function cachedExpressions() {
  const memo = new Map();               // src -> Map(valueKey -> boolean)
  let hits = 0, misses = 0, exprCalls = 0;
  return { stats: () => ({ hits, misses, exprCalls, entries: [...memo.values()].reduce((s,m)=>s+m.size,0) }),
    unaryTest(test, context) {
      const v = context['?'];
      const key = (v === null || typeof v !== 'object') ? `${typeof v}:${v}` : JSON.stringify(v);
      let m = memo.get(test); if (!m) { m = new Map(); memo.set(test, m); }
      if (m.has(key)) { hits++; return m.get(key); }
      misses++;
      const { value, warnings } = feelin.unaryTest(test, context);
      if (warnings?.length) console.error('FEEL WARN', test, warnings.map(w=>w.type));
      m.set(key, value); return value;
    },
    resolveExpression(expression, context) {
      exprCalls++;
      const { value, warnings } = feelin.evaluate(expression, context);
      if (warnings?.length) console.error('FEEL WARN', expression, warnings.map(w=>w.type));
      return value;
    } };
}
const ce = cachedExpressions();
const cached = new Definition(new Context(rootElement, new Environment({ expressions: ce })));

function ctx() {
  const c = {};
  for (const [n,d] of Object.entries(INPUTS)) {
    if (d.kind==='enum') c[n]=d.values[(Math.random()*d.values.length)|0];
    else if (d.kind==='int') c[n]= Math.random()<0.5 ? d.partition[0]-1 : d.partition[0]+1000;
  }
  c.labelSetTokens=(Math.random()*4000)|0; c.budgetCapTokens=(Math.random()*4000)|0;
  c.replayedInjectionTokens=(Math.random()*4000)|0; c.cumulativeCap=(Math.random()*4000)|0;
  c.permanentCorrections=(Math.random()*20)|0; c.correctionCap=(Math.random()*20)|0;
  return c;
}
async function evalAll(def){ const c=ctx(); for(const d of DECISIONS) await def.evaluate(d.id,c); }

// EQUIVALENCE CHECK: cached must agree with baseline on random contexts
let mism=0;
for (let i=0;i<300;i++){ const c=ctx();
  for(const d of DECISIONS){ const a=await base.evaluate(d.id,c), b=await cached.evaluate(d.id,c);
    if (JSON.stringify(a)!==JSON.stringify(b)) { mism++; if(mism<3) console.log('MISMATCH',d.id,JSON.stringify(a),JSON.stringify(b)); } } }
console.log(`equivalence over 300 contexts x 10 decisions: mismatches=${mism}`);

async function bench(name, def, warm, N){
  for(let i=0;i<warm;i++) await evalAll(def);
  const s=new Float64Array(N);
  for(let i=0;i<N;i++){ const t=performance.now(); await evalAll(def); s[i]=performance.now()-t; }
  const so=Float64Array.from(s).sort();
  const P=p=>so[Math.min(so.length-1,Math.floor(p/100*so.length))];
  let sum=0; for(const v of so) sum+=v;
  console.log(`${name.padEnd(10)} N=${String(N).padStart(6)}  mean ${(sum/N).toFixed(4)}  p50 ${P(50).toFixed(4)}  p90 ${P(90).toFixed(4)}  p99 ${P(99).toFixed(4)}  p99.9 ${P(99.9).toFixed(4)}  max ${so.at(-1).toFixed(4)} ms`);
  return {p50:P(50),p99:P(99)};
}
console.log('\n--- baseline (stock feelin, re-parses per cell) ---');
const b = await bench('baseline', base, 500, 1000);
console.log('--- cached expressions (memoised unary tests) ---');
const c = await bench('cached', cached, 2000, 5000);
console.log('\ncache stats:', JSON.stringify(ce.stats()));
console.log(`\nspeedup: p50 ${(b.p50/c.p50).toFixed(1)}x   p99 ${(b.p99/c.p99).toFixed(1)}x`);
console.log(`budget (p50<=0.5ms, p99<=2ms): baseline ${b.p50<=0.5?'PASS':'FAIL'}/${b.p99<=2?'PASS':'FAIL'}   cached ${c.p50<=0.5?'PASS':'FAIL'}/${c.p99<=2?'PASS':'FAIL'}`);
