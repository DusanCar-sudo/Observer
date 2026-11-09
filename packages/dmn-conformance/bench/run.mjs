/**
 * DMN decision-layer benchmark. Methodology fixed in advance in
 * docs/spec/dmn-benchmark-plan.md — read that first; §9 of it binds this script.
 *
 * Run: pnpm --filter @observer/dmn-conformance bench
 *      (needs --expose-gc for B3; the package.json script sets it)
 *
 * Reports B1/B2/B3 (evaluation latency + allocation), B4 (load), B5a/b/c (load-time checks).
 * Anything it cannot measure, it says so rather than guessing.
 */
import { performance, PerformanceObserver } from 'node:perf_hooks';
import os from 'node:os';
import { Context, Definition } from 'dmn-elements';
import { DmnModdle } from 'dmn-moddle';
import { parser as feelParser } from '@bpmn-io/lezer-feel';
import { buildPolicyXml, DECISIONS, INPUTS, BUNDLE_STATS, product, probeValue } from '../fixtures/policy.mjs';

const exprParser = feelParser;
const unaryParser = feelParser.configure({ top: 'UnaryTests' });

const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const hr = () => say('\n' + '─'.repeat(78));

// ── environment disclosure (plan §4) ──────────────────────────────────────────
hr();
say('ENVIRONMENT');
say(`  node            ${process.version}  ${process.platform}/${process.arch}`);
say(`  cpu             ${os.cpus()[0]?.model?.trim() ?? 'unknown'}  (${os.cpus().length} logical)`);
say(`  expose-gc       ${typeof globalThis.gc === 'function' ? 'yes' : 'NO — B3 unavailable'}`);
say(`  loadavg         ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);
say(`  heapTotal       ${(process.memoryUsage().heapTotal / 1048576).toFixed(1)} MB`);
say(`  engines         dmn-elements 0.4.1 / feelin 8.2.0 / dmn-moddle 12.2.1 (exact pins)`);

// ── bundle ────────────────────────────────────────────────────────────────────
const xml = buildPolicyXml();
hr();
say('BUNDLE (synthetic fixture — see fixtures/policy.mjs header caveat)');
say(`  xml bytes       ${Buffer.byteLength(xml).toLocaleString()}`);
say(`  decisions       ${BUNDLE_STATS.decisions}   distinct inputs ${BUNDLE_STATS.inputs}`);
say(`  rules total     ${BUNDLE_STATS.rules}`);
for (const [id, n] of Object.entries(BUNDLE_STATS.perDecision)) say(`    ${id.padEnd(20)} ${String(n).padStart(4)} cells`);

// ── B4: load / compile ────────────────────────────────────────────────────────
const moddle = new DmnModdle();
async function loadOnce() {
  const { rootElement } = await moddle.fromXML(xml);
  const def = new Definition(new Context(rootElement));
  return def;
}
const t0 = performance.now();
const definition = await loadOnce();
const coldMs = performance.now() - t0;

const LOAD_ITERS = 100;
const loadSamples = [];
for (let i = 0; i < LOAD_ITERS; i++) {
  const t = performance.now();
  await loadOnce();
  loadSamples.push(performance.now() - t);
}
loadSamples.sort((a, b) => a - b);
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];

hr();
say('B4 — BUNDLE LOAD (XML → moddle → Definition)');
say(`  cold first load  ${coldMs.toFixed(2)} ms   (includes module init + JIT; not comparable to warm)`);
say(`  warm over ${LOAD_ITERS} loads:  p50 ${pct(loadSamples, 50).toFixed(2)} ms   p99 ${pct(loadSamples, 99).toFixed(2)} ms   max ${loadSamples.at(-1).toFixed(2)} ms`);
say(`  verdict vs 50 ms target: ${pct(loadSamples, 99) <= 50 ? 'PASS' : 'FAIL'} (warm p99)`);

// ── B5a: static identifier extraction over every FEEL cell ───────────────────
function collectIdentifiers(text, isUnary) {
  const p = isUnary ? unaryParser : exprParser;
  const tree = p.parse(text);
  const names = new Set();
  const nodeKinds = new Set();
  tree.cursor().iterate((node) => {
    nodeKinds.add(node.name);
    if (/Name|Variable|Identifier/i.test(node.name) && node.node.firstChild === null) {
      names.add(text.slice(node.from, node.to));
    }
  });
  return { names, nodeKinds };
}

function walkCells(def) {
  // Reach into the parsed model for every FEEL text we must statically check.
  const cells = [];
  const root = definition?.context?.definitions ?? null;
  // dmn-elements keeps the moddle root on the Context; fall back to re-parsing if shape differs.
  const visit = (el) => {
    if (!el || typeof el !== 'object') return;
    if (el.$type === 'dmn:InputEntry' || el.$type === 'dmn:OutputEntry' || el.$type === 'dmn:LiteralExpression') {
      if (typeof el.text === 'string' && el.text.trim()) {
        cells.push({ text: el.text, unary: el.$type === 'dmn:InputEntry' });
      }
    }
    for (const k of Object.keys(el)) {
      if (k.startsWith('$')) continue;
      const v = el[k];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object' && v.$type) visit(v);
    }
  };
  if (root) visit(root);
  return cells;
}

// Re-parse to get the raw moddle tree for cell walking (independent of dmn-elements internals).
const { rootElement: rawRoot } = await moddle.fromXML(xml);
const cells = [];
{
  const visit = (el) => {
    if (!el || typeof el !== 'object') return;
    if ((el.$type === 'dmn:InputEntry' || el.$type === 'dmn:OutputEntry') && typeof el.text === 'string' && el.text.trim()) {
      cells.push({ text: el.text, unary: el.$type === 'dmn:InputEntry' });
    }
    if (el.$type === 'dmn:LiteralExpression' && typeof el.text === 'string' && el.text.trim()) {
      cells.push({ text: el.text, unary: false });
    }
    for (const k of Object.keys(el)) {
      if (k.startsWith('$')) continue;
      const v = el[k];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object' && v.$type) visit(v);
    }
  };
  visit(rawRoot);
}

const CONFERRAL_ALLOWLIST = new Set(
  Object.keys(INPUTS).filter((k) => !INPUTS[k].modelDerived)
    // numeric backers referenced by cmp expressions are deterministic too
    .concat(['labelSetTokens', 'budgetCapTokens', 'replayedInjectionTokens', 'cumulativeCap', 'permanentCorrections', 'correctionCap'])
);

function runStaticCheck() {
  const kinds = new Set();
  const found = new Set();
  let parsed = 0;
  for (const c of cells) {
    const { names, nodeKinds } = collectIdentifiers(c.text, c.unary);
    names.forEach((n) => found.add(n));
    nodeKinds.forEach((k) => kinds.add(k));
    parsed++;
  }
  return { parsed, found, kinds };
}

const B5A_ITERS = 100;
let b5aRes = runStaticCheck();
const b5a = [];
for (let i = 0; i < B5A_ITERS; i++) { const t = performance.now(); runStaticCheck(); b5a.push(performance.now() - t); }
b5a.sort((a, b) => a - b);

hr();
say('B5a — STATIC IDENTIFIER EXTRACTION (lezer-feel) over every FEEL cell');
say(`  cells parsed    ${b5aRes.parsed}`);
say(`  identifiers     ${[...b5aRes.found].sort().join(', ')}`);
say(`  unexpected ids  ${[...b5aRes.found].filter((n) => !CONFERRAL_ALLOWLIST.has(n)).join(', ') || '(none)'}`);
say(`  p50 ${pct(b5a, 50).toFixed(3)} ms   p99 ${pct(b5a, 99).toFixed(3)} ms   (over ${B5A_ITERS} runs)`);

// ── B5b: synthetic full-context evaluation, zero warnings / zero nulls ───────
function syntheticContext() {
  const ctx = {};
  for (const [name, def] of Object.entries(INPUTS)) {
    if (def.kind === 'enum') ctx[name] = def.values[0];
    else if (def.kind === 'cmp') { for (const t of def.expr.match(/[A-Za-z][A-Za-z0-9_]*/g) || []) ctx[t] = 1; }
    else if (def.kind === 'int') ctx[name] = def.partition[0];
  }
  return ctx;
}
async function runSyntheticCheck(def) {
  const ctx = syntheticContext();
  let nulls = 0;
  for (const d of DECISIONS) {
    const r = await def.evaluate(d.id, ctx);
    if (r === null || r === undefined) nulls++;
  }
  return { nulls, decisions: DECISIONS.length };
}
const B5B_ITERS = 100;
const synth = await runSyntheticCheck(definition);
const b5b = [];
for (let i = 0; i < B5B_ITERS; i++) { const t = performance.now(); await runSyntheticCheck(definition); b5b.push(performance.now() - t); }
b5b.sort((a, b) => a - b);
hr();
say('B5b — SYNTHETIC FULL-CONTEXT EVALUATION (every input present and non-null)');
say(`  decisions       ${synth.decisions}   null results ${synth.nulls} ${synth.nulls === 0 ? '✓' : '✗ FAIL'}`);
say(`  FEEL warnings   not surfaced by dmn-elements evaluate() — see results doc caveat`);
say(`  p50 ${pct(b5b, 50).toFixed(3)} ms   p99 ${pct(b5b, 99).toFixed(3)} ms   (over ${B5B_ITERS} runs)`);

// ── B5c: gap / overlap product enumeration ───────────────────────────────────
async function runCompleteness(def) {
  let cellsChecked = 0; const gaps = []; const overlaps = [];
  for (const d of DECISIONS) {
    for (const combo of product(d)) {
      const ctx = {};
      d.inputs.forEach((name, i) => {
        const def2 = INPUTS[name];
        ctx[name] = probeValue(name, combo[i]);
        if (def2.kind === 'cmp') {
          // supply backers so the comparison evaluates deterministically to the intended boolean
          const [lhs, rhs] = (def2.expr.match(/[A-Za-z][A-Za-z0-9_]*/g) || []);
          const want = combo[i] === true;
          ctx[lhs] = want ? 1 : 10; ctx[rhs] = want ? 10 : 1;
        }
      });
      cellsChecked++;
      try {
        const r = await def.evaluate(d.id, ctx);
        if (r === null || r === undefined) gaps.push({ d: d.id, ctx });
      } catch (e) {
        if (/hit policy violated/i.test(String(e.message))) overlaps.push({ d: d.id, ctx });
        else throw e;
      }
    }
  }
  return { cellsChecked, gaps, overlaps };
}
const B5C_ITERS = 10;
const comp = await runCompleteness(definition);
const b5c = [];
for (let i = 0; i < B5C_ITERS; i++) { const t = performance.now(); await runCompleteness(definition); b5c.push(performance.now() - t); }
b5c.sort((a, b) => a - b);
hr();
say('B5c — GAP / OVERLAP PRODUCT ENUMERATION (decision-model.md §6.1)');
say(`  cells checked   ${comp.cellsChecked}`);
say(`  gaps            ${comp.gaps.length} ${comp.gaps.length === 0 ? '✓' : '✗ ' + JSON.stringify(comp.gaps.slice(0, 2))}`);
say(`  overlaps        ${comp.overlaps.length} ${comp.overlaps.length === 0 ? '✓' : '✗'}`);
say(`  p50 ${pct(b5c, 50).toFixed(2)} ms   max ${b5c.at(-1).toFixed(2)} ms   (over ${B5C_ITERS} runs)`);
say(`  vs 50 ms hot-reload target: ${pct(b5c, 50) <= 50 ? 'FITS at load time' : 'EXCEEDS — must move to build time'}`);

// ── B1/B2/B3: evaluation latency ─────────────────────────────────────────────
function randomContext() {
  const ctx = {};
  for (const [name, def] of Object.entries(INPUTS)) {
    if (def.kind === 'enum') ctx[name] = def.values[(Math.random() * def.values.length) | 0];
    else if (def.kind === 'int') ctx[name] = Math.random() < 0.5 ? def.partition[0] - 1 : def.partition[0] + 1000;
  }
  // numeric backers, randomised so cmp inputs vary
  ctx.labelSetTokens = (Math.random() * 4000) | 0;      ctx.budgetCapTokens = (Math.random() * 4000) | 0;
  ctx.replayedInjectionTokens = (Math.random() * 4000) | 0; ctx.cumulativeCap = (Math.random() * 4000) | 0;
  ctx.permanentCorrections = (Math.random() * 20) | 0;  ctx.correctionCap = (Math.random() * 20) | 0;
  return ctx;
}

// One "decision-layer evaluation" = every decision evaluated against one global context.
// That is the unit that sits on the request path.
async function evaluateAll(def) {
  const ctx = randomContext();
  let acc = 0;
  for (const d of DECISIONS) { const r = await def.evaluate(d.id, ctx); if (r) acc++; }
  return acc;
}

// pilot to size N so the sampling run is ~20s (plan §9.3: no re-running for a better number)
const PILOT = 500;
let tp = performance.now();
for (let i = 0; i < PILOT; i++) await evaluateAll(definition);
const pilotPer = (performance.now() - tp) / PILOT;
const TARGET_MS = 20000;
const N = Math.max(2000, Math.min(200000, Math.floor(TARGET_MS / pilotPer)));

const gcEvents = [];
let obs;
try {
  obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcEvents.push(e.detail?.kind ?? e.name); });
  obs.observe({ entryTypes: ['gc'] });
} catch { /* gc observation unavailable */ }

// warm-up (plan §4): 5000 discarded
for (let i = 0; i < 5000; i++) await evaluateAll(definition);

let heapBefore = null, heapAfter = null;
if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); heapBefore = process.memoryUsage().heapUsed; }

const samples = new Float64Array(N);
gcEvents.length = 0;
const tStart = performance.now();
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await evaluateAll(definition);
  samples[i] = performance.now() - t;
}
const wallMs = performance.now() - tStart;

if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); heapAfter = process.memoryUsage().heapUsed; }
if (obs) obs.disconnect();

const sorted = Float64Array.from(samples).sort();
const P = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
let sum = 0; for (const v of sorted) sum += v;

hr();
say('B1/B2 — DECISION-LAYER EVALUATION LATENCY (all 10 decisions, one global context)');
say(`  pilot           ${pilotPer.toFixed(4)} ms per evaluation → chose N = ${N.toLocaleString()}`);
say(`  warm-up         5,000 discarded iterations`);
say(`  samples         ${N.toLocaleString()}  (all retained, sorted; no reservoir sampling)`);
say(`  wall clock      ${(wallMs / 1000).toFixed(1)} s`);
say(`  mean            ${(sum / N).toFixed(4)} ms`);
say(`  p50             ${P(50).toFixed(4)} ms`);
say(`  p90             ${P(90).toFixed(4)} ms`);
say(`  p99             ${P(99).toFixed(4)} ms`);
say(`  p99.9           ${P(99.9).toFixed(4)} ms`);
say(`  max             ${sorted.at(-1).toFixed(4)} ms`);
say(`  GC events during sampling: ${gcEvents.length}${gcEvents.length ? ' — p99.9 partly reflects GC, label accordingly' : ''}`);
say(`  vs budget (p50 ≤ 0.5 ms, p99 ≤ 2 ms): p50 ${P(50) <= 0.5 ? 'PASS' : 'FAIL'}   p99 ${P(99) <= 2 ? 'PASS' : 'FAIL'}`);

hr();
say('B3 — ALLOCATION');
if (heapBefore !== null && heapAfter !== null) {
  const per = (heapAfter - heapBefore) / N;
  say(`  heapUsed delta  ${((heapAfter - heapBefore) / 1048576).toFixed(2)} MB over ${N.toLocaleString()} evaluations`);
  say(`  per evaluation  ${per.toFixed(1)} bytes  (${(per * 10).toFixed(0)} bytes per decision)`);
  say(`  note            measured after forced gc(); a negative value means the heap shrank (GC timing), not negative allocation`);
} else {
  say('  NOT MEASURED — --expose-gc unavailable');
}

hr();
say('PER-DECISION BREAKDOWN (1,000 evaluations each, p50/p99)');
for (const d of DECISIONS) {
  const s = [];
  for (let i = 0; i < 500; i++) await definition.evaluate(d.id, randomContext());   // warm
  for (let i = 0; i < 1000; i++) { const t = performance.now(); await definition.evaluate(d.id, randomContext()); s.push(performance.now() - t); }
  s.sort((a, b) => a - b);
  const ctxSize = Object.keys(randomContext()).length;
  say(`  ${d.id.padEnd(20)} cells ${String(BUNDLE_STATS.perDecision[d.id]).padStart(3)}   p50 ${pct(s, 50).toFixed(4)} ms   p99 ${pct(s, 99).toFixed(4)} ms   (ctx ${ctxSize} keys)`);
}

hr();
say('NOT MEASURED BY THIS SCRIPT (plan §8) — stated, not inferred:');
say('  · the real DRD (does not exist; fixture is shape-equivalent only)');
say('  · concurrency / GC behaviour under parallel sessions (single-threaded here)');
say('  · interaction with the request path (capture, hashing, spool, SSE tee)');
say('  · tail behaviour under production heap pressure');
say('  · total process cold start');

console.log('\n' + '═'.repeat(78));
console.log('done');
