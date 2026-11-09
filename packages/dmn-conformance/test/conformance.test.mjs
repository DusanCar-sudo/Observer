/**
 * Conformance + equivalence suite.
 *
 * This is the file that turns docs/research/dmn-execution-landscape.md §5A from a claim I made once
 * into a test that fails when the claim stops being true — i.e. when the pinned engines change
 * behaviour underneath us. Every assertion here was first observed by hand; it is now pinned.
 *
 * Two jobs:
 *   1. PROVE the compiled lookup tables are equivalent to the engine, exhaustively (not sampled).
 *   2. PIN the engine behaviours our design depends on, including the hazardous ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { evaluate, unaryTest } from 'feelin';
import { parser as feelParser } from '@bpmn-io/lezer-feel';
import { Context, Definition } from 'dmn-elements';
import { DmnModdle } from 'dmn-moddle';
import { buildPolicyXml, DECISIONS, INPUTS, BUNDLE_STATS, product } from '../fixtures/policy.mjs';
import { compileBundle, makeKeyFn, evaluateCompiled, loadDefinition } from '../src/compile.mjs';

const moddle = new DmnModdle();
const xml = buildPolicyXml();

let def, compiled, keyFns;
beforeAll(async () => {
  def = await loadDefinition(xml);
  compiled = await compileBundle(xml, DECISIONS, INPUTS);
  keyFns = new Map(DECISIONS.map((d) => [d.id, makeKeyFn(d, INPUTS)]));
}, 120_000);

/** Build a live context that lands on a specific cell of a decision's product. */
function contextFor(decision, combo) {
  const ctx = {};
  decision.inputs.forEach((name, i) => {
    const idef = INPUTS[name];
    const m = combo[i];
    if (idef.kind === 'int') ctx[name] = m.hi ? idef.partition[0] - 1 : idef.partition[0] + 1000;
    else if (idef.kind === 'cmp') {
      const [lhs, rhs] = idef.expr.match(/[A-Za-z][A-Za-z0-9_]*/g);
      ctx[lhs] = m === true ? 1 : 10; ctx[rhs] = m === true ? 10 : 1;
    } else ctx[name] = m;
  });
  // fill every other declared input so nothing is null (Landscape §5A.1: null is silent)
  for (const [name, idef] of Object.entries(INPUTS)) {
    if (name in ctx) continue;
    if (idef.kind === 'enum') ctx[name] = idef.values[0];
    else if (idef.kind === 'int') ctx[name] = idef.partition[0];
  }
  for (const n of ['labelSetTokens', 'budgetCapTokens', 'replayedInjectionTokens', 'cumulativeCap',
    'permanentCorrections', 'correctionCap']) if (!(n in ctx)) ctx[n] = 1;
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('compiled lookup tables are equivalent to the engine', () => {
  it('compiles every cell of every decision', () => {
    expect(compiled.cells).toBe(BUNDLE_STATS.rules);
    expect(BUNDLE_STATS.rules).toBe(195);           // Appendix A §A.3 — change deliberately or not at all
    expect(compiled.tables.size).toBe(DECISIONS.length);
  });

  it('agrees with the engine on EVERY cell, exhaustively', async () => {
    let checked = 0;
    for (const d of DECISIONS) {
      for (const combo of product(d)) {
        const ctx = contextFor(d, combo);
        const viaEngine = await def.evaluate(d.id, ctx);
        const viaCompiled = evaluateCompiled(compiled.tables, keyFns, d.id, ctx);
        expect(viaCompiled, `${d.id} cell ${JSON.stringify(combo)}`).toEqual(viaEngine);
        expect(viaEngine, `${d.id} cell must not be null (gap)`).not.toBeNull();
        checked++;
      }
    }
    expect(checked).toBe(195);
  }, 120_000);

  it('produces no null (gap) for any random context', async () => {
    for (let i = 0; i < 500; i++) {
      const ctx = contextFor(DECISIONS[0], product(DECISIONS[0])[i % product(DECISIONS[0]).length]);
      for (const d of DECISIONS) {
        expect(evaluateCompiled(compiled.tables, keyFns, d.id, ctx), `${d.id} returned undefined`).toBeDefined();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('completeness / overlap detection (decision-model.md §6.1)', () => {
  const tbl = (rules, hitPolicy = 'UNIQUE', defaultEntry = '') => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="t" name="t" namespace="http://o/t">
 <inputData id="i1" name="verdict"><variable id="v1" name="verdict" typeRef="string"/></inputData>
 <inputData id="i2" name="severity"><variable id="v2" name="severity" typeRef="string"/></inputData>
 <decision id="dec" name="dec">
  <informationRequirement id="ir_x1"><requiredInput href="#i1"/></informationRequirement>
  <informationRequirement id="ir_x2"><requiredInput href="#i2"/></informationRequirement>
  <decisionTable id="dt" hitPolicy="${hitPolicy}">
   <input id="a" label="verdict"><inputExpression id="ae" typeRef="string"><text>verdict</text></inputExpression></input>
   <input id="b" label="severity"><inputExpression id="be" typeRef="string"><text>severity</text></inputExpression></input>
   <output id="o" name="action" label="action" typeRef="string">${defaultEntry
      ? `<defaultOutputEntry id="doe"><text>${defaultEntry}</text></defaultOutputEntry>` : ''}</output>
   ${rules}
  </decisionTable>
 </decision>
</definitions>`;
  const rule = (i, v, s, out) => `<rule id="rule_${i}">
    <inputEntry id="i${i}a"><text>${v}</text></inputEntry>
    <inputEntry id="i${i}b"><text>${s}</text></inputEntry>
    <outputEntry id="o${i}"><text>"${out}"</text></outputEntry></rule>`;

  it('a GAP returns null silently — no error, no warning (pinned hazard)', async () => {
    const d = await loadDefinition(tbl(rule(0, '"grounded"', '"low"', 'pass')));
    expect(await d.evaluate('dec', { verdict: 'unverified', severity: 'critical' })).toBeNull();
  });

  it('an OVERLAP under UNIQUE throws, but only when an input actually hits it', async () => {
    const d = await loadDefinition(tbl(
      rule(0, '"contradicted"', '-', 'block') + rule(1, '-', '"high"', 'annotate')));
    // non-overlapping input resolves normally (only r1 matches: severity "low" is not "high")
    await expect(d.evaluate('dec', { verdict: 'grounded', severity: 'low' })).resolves.toBeNull();
    // overlapping input: throws
    await expect(d.evaluate('dec', { verdict: 'contradicted', severity: 'high' }))
      .rejects.toThrow(/hit policy violated/i);
  });

  it('a catch-all row creates overlaps under UNIQUE — completeness and UNIQUE are mutually exclusive', async () => {
    const d = await loadDefinition(tbl(
      rule(0, '"grounded"', '"low"', 'pass') + rule(1, '-', '-', 'observe')));
    await expect(d.evaluate('dec', { verdict: 'grounded', severity: 'low' }))
      .rejects.toThrow(/hit policy violated/i);
  });

  it('compileBundle rejects a bundle with a gap (gap = build failure)', async () => {
    const incomplete = tbl(rule(0, '"grounded"', '"low"', 'pass'));
    const decs = [{ id: 'dec', hitPolicy: 'UNIQUE', out: 'action', values: ['pass'],
      inputs: ['verdict', 'severity'] }];
    await expect(compileBundle(incomplete, decs, INPUTS)).rejects.toThrow(/gap/i);
  });

  it('default output entries MASK gaps — so they are banned by the subset', async () => {
    const d = await loadDefinition(tbl(rule(0, '"grounded"', '"low"', 'pass'), 'UNIQUE',
      '"fallback"'));
    // with a default, an uncovered cell no longer returns null: the gap is invisible
    expect(await d.evaluate('dec', { verdict: 'unverified', severity: 'critical' })).not.toBeNull();
  });

  it('DUPLICATE element ids silently drop rules — no error, no warning (pinned hazard)', async () => {
    // Found by accident while writing this suite: an <informationRequirement id="r1"> colliding
    // with a <rule id="r1"> made that rule stop matching entirely. Nothing was reported. A
    // hand-authored table with a duplicated id therefore loses rules SILENTLY, which for a
    // supervisor is silent inaction. Ids must be generated mechanically and linted for uniqueness.
    const collide = (dupId) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="t" name="t" namespace="http://o/t2">
 <inputData id="i1" name="verdict"><variable id="v1" name="verdict" typeRef="string"/></inputData>
 <decision id="dec" name="dec">
  <informationRequirement id="${dupId ? 'r1' : 'ir_unique'}"><requiredInput href="#i1"/></informationRequirement>
  <decisionTable id="dt" hitPolicy="UNIQUE">
   <input id="a" label="verdict"><inputExpression id="ae" typeRef="string"><text>verdict</text></inputExpression></input>
   <output id="o" name="action" label="action" typeRef="string"/>
   <rule id="r0"><inputEntry id="e0"><text>"a"</text></inputEntry><outputEntry id="p0"><text>"zero"</text></outputEntry></rule>
   <rule id="r1"><inputEntry id="e1"><text>"b"</text></inputEntry><outputEntry id="p1"><text>"one"</text></outputEntry></rule>
  </decisionTable>
 </decision>
</definitions>`;
    const collided = await loadDefinition(collide(true));
    const clean = await loadDefinition(collide(false));
    // the colliding bundle silently loses rule r1; the clean one does not
    expect(await clean.evaluate('dec', { verdict: 'b' })).toBe('one');
    expect(await collided.evaluate('dec', { verdict: 'b' })).toBeNull();
  });

  it('PRIORITY refuses to run without outputValues (fails loudly, as we want)', async () => {
    const d = await loadDefinition(tbl(
      rule(0, '"contradicted"', '-', 'block') + rule(1, '-', '"high"', 'annotate'), 'PRIORITY'));
    await expect(d.evaluate('dec', { verdict: 'contradicted', severity: 'high' }))
      .rejects.toThrow(/requires output values/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pinned FEEL hazards (Landscape §5A.1, §5A.2) — the reason for the subset', () => {
  it('unknown variable yields null WITH a warning (catchable)', () => {
    const r = evaluate('modelVerdict > 1', {});
    expect(r.value).toBeNull();
    expect(r.warnings.map((w) => w.type)).toContain('NO_VARIABLE_FOUND');
  });

  it('present-but-null yields null with NO warning (uncatchable — hence static identifier checks)', () => {
    const r = evaluate('a > 5', { a: null });
    expect(r.value).toBeNull();
    expect(r.warnings).toHaveLength(0);   // ← the hole. Do not "fix" this test without updating Q3 Hole 1.
  });

  it('FEEL uses IEEE-754 doubles, not DMN decimal — hence no arithmetic in policy', () => {
    expect(evaluate('0.1 + 0.2', {}).value).not.toBe(0.3);
    expect(evaluate('0.1 + 0.2 = 0.3', {}).value).toBe(false);
  });

  it('unbounded intervals are a syntax error — use >= n, never [n..)', () => {
    for (const bad of ['[32768..)', '[32768..]', ']32768..)', '32768..']) {
      expect(() => unaryTest(bad, { '?': 40000 }), bad).toThrow(/SyntaxError|Unrecognized/i);
    }
    expect(unaryTest('>= 32768', { '?': 40000 }).value).toBe(true);
    expect(unaryTest('[0..32768)', { '?': 32768 }).value).toBe(false);
    expect(unaryTest('[0..32768)', { '?': 32767 }).value).toBe(true);
  });

  it('permitted subset constructs all behave as documented', () => {
    expect(unaryTest('-', { '?': 'anything' }).value).toBe(true);
    expect(unaryTest('"grounded","contradicted"', { '?': 'grounded' }).value).toBe(true);
    expect(unaryTest('not("grounded")', { '?': 'grounded' }).value).toBe(false);
    expect(evaluate('v = "grounded" and not(s)', { v: 'grounded', s: false }).value).toBe(true);
    expect(evaluate('s in ["high","critical"]', { s: 'critical' }).value).toBe(true);
    expect(evaluate('a <= b', { a: 1500, b: 2000 }).value).toBe(true);
    expect(evaluate('count(xs) >= 3', { xs: [1, 2, 3] }).value).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('conformance subset enforcement (decision-model.md §2.1)', () => {
  it('rejects single-letter hit policy notation', async () => {
    // NOTE: replaces the FIRST UNIQUE table, which is groundingBaseline — evaluate that one.
    const bad = xml.replace('hitPolicy="UNIQUE"', 'hitPolicy="U"');
    expect(bad).not.toBe(xml);
    const d = await loadDefinition(bad);
    await expect(d.evaluate('groundingBaseline', { verdict: 'grounded', evidenceClass: 'none', severity: 'low' }))
      .rejects.toThrow(/unsupported hit policy/);
  });

  it('bundle uses only permitted hit policies', () => {
    for (const d of DECISIONS) expect(['UNIQUE', 'PRIORITY'], d.id).toContain(d.hitPolicy);
  });

  it('no model-derived input is referenced by a conferral decision (I5, structural)', () => {
    const unary = feelParser.configure({ top: 'UnaryTests' });
    const modelInputs = new Set(Object.keys(INPUTS).filter((k) => INPUTS[k].modelDerived));
    expect(modelInputs.size).toBeGreaterThan(0);

    const conferral = DECISIONS.filter((d) => !d.inputs.some((n) => INPUTS[n].modelDerived));
    expect(conferral.length).toBeGreaterThan(0);

    // static identifier extraction over every cell of every conferral table
    for (const d of conferral) {
      const idx = DECISIONS.indexOf(d);
      const cells = [...xml.matchAll(new RegExp(`id="(?:re|oe|ie)_${d.id}[^"]*"\\s*>\\s*<text>([^<]*)</text>`, 'g'))]
        .map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      expect(cells.length, `${d.id}: expected cells`).toBeGreaterThan(0);
      const refs = new Set();
      for (const c of cells) {
        const tree = (c.includes('"') || /^[-<>=]/.test(c.trim()) ? unary : feelParser).parse(c);
        tree.cursor().iterate((n) => {
          if (/Name|Variable|Identifier/i.test(n.name) && n.node.firstChild === null) refs.add(c.slice(n.from, n.to));
        });
      }
      const leaked = [...refs].filter((r) => modelInputs.has(r));
      expect(leaked, `${d.id} (conferral) references model-derived input`).toEqual([]);
      void idx;
    }
  });
});
