/**
 * Synthetic Observer policy bundle, shaped per docs/spec/decision-model.md §4 (DRD) and
 * Appendix A (input domains and cardinalities).
 *
 * IMPORTANT — this is a BENCHMARK FIXTURE, not the real policy. The real tables have not been
 * authored by anyone yet. This generates a DRD of the same *shape* (10 decisions, the Appendix A
 * domains, the two permitted hit policies) so that latency numbers are about the engine and the
 * graph size rather than about a made-up table. Output values are assigned by a deterministic
 * scoring function, NOT by real policy semantics — see pickOutput(). When the real tables exist,
 * re-run the benchmark against them and supersede the numbers.
 *
 * Tables are generated COMPLETE and DISJOINT (every cell of the per-decision cartesian product has
 * exactly one rule), which is what docs/spec/decision-model.md §6.1 requires under hit policy
 * UNIQUE — a catch-all row would create overlaps.
 */

/** Every distinct input in the bundle, with its domain. Appendix A §A.1. */
export const INPUTS = {
  // ── deterministic (conferral subgraph) ────────────────────────────────────
  verdict:             { kind: 'enum', type: 'string',  values: ['grounded', 'contradicted', 'unverified', 'not-a-claim'] },
  evidenceClass:       { kind: 'enum', type: 'string',  values: ['wire-observed', 'ledger-corroborated', 'filesystem-only', 'config', 'none'] },
  severity:            { kind: 'enum', type: 'string',  values: ['info', 'low', 'high', 'critical'] },
  checkerStatus:       { kind: 'enum', type: 'string',  values: ['ok', 'errored', 'timed-out', 'not-configured'] },
  leaseState:          { kind: 'enum', type: 'string',  values: ['granted', 'withheld'] },
  protocolCapability:  { kind: 'enum', type: 'string',  values: ['openai-chat-stateless', 'anthropic-messages', 'openai-responses-stateful', 'unknown'] },
  betaHeaderAccepted:  { kind: 'enum', type: 'string',  values: ['yes', 'no', 'not-applicable'] },
  budgetStatus:        { kind: 'enum', type: 'string',  values: ['within', 'exceeds', 'unknown'] },
  labelSetStatus:      { kind: 'enum', type: 'string',  values: ['new', 'changed', 'unchanged'] },
  disclosureState:     { kind: 'enum', type: 'string',  values: ['not-emitted', 'emitted'] },
  flipSignal:          { kind: 'enum', type: 'string',  values: ['none', 'canary-miss', 'attestation-missing', 'honeypot-hit', 'coverage-anomaly'] },
  partialTranscript:   { kind: 'enum', type: 'boolean', values: [false, true] },
  // derived-by-projection integer comparisons (verified working, Landscape §5A)
  withinBudget:        { kind: 'cmp', type: 'boolean', expr: 'labelSetTokens <= budgetCapTokens' },
  replayWithinCap:     { kind: 'cmp', type: 'boolean', expr: 'replayedInjectionTokens <= cumulativeCap' },
  correctionsBelowCap: { kind: 'cmp', type: 'boolean', expr: 'permanentCorrections < correctionCap' },
  // raw integer, banded by the literals in its own cells (Appendix A §A.2)
  headroomRemaining:   { kind: 'int', type: 'number', expr: 'headroomRemaining', partition: [32768] },
  // ── model-derived (reduction subgraph ONLY) ───────────────────────────────
  judgeVerdict:        { kind: 'enum', type: 'string', values: ['escalate', 'no-opinion'], modelDerived: true },
  judgeConfidence:     { kind: 'enum', type: 'string', values: ['low', 'high'], modelDerived: true },
  escalationSignal:    { kind: 'enum', type: 'string', values: ['none', 'mild', 'strong'], modelDerived: true },
};

const ACTION = ['allow', 'annotate', 'challenge', 'block'];
const CEILING = ['no-opinion', 'at-most-annotate', 'at-most-challenge', 'at-most-block'];

/**
 * Deterministic pseudo-policy. Ranks the inputs and maps the sum onto the output domain.
 * NOT real semantics — it exists so the bundle is stable and reproducible across runs.
 */
function pickOutput(outputValues, cell, inputs) {
  let score = 0;
  inputs.forEach((name, i) => {
    const def = INPUTS[name];
    const v = cell[i];
    if (def.kind === 'enum') score += def.values.indexOf(v) * (i + 1);
    else if (def.kind === 'cmp') score += (v === true ? 1 : 0) * (i + 1);
    else if (def.kind === 'int') score += (v >= 32768 ? 0 : 1) * (i + 1);
  });
  return outputValues[score % outputValues.length];
}

/** The ten decisions of the DRD, with the inputs each declares. Appendix A §A.3. */
export const DECISIONS = [
  { id: 'groundingBaseline',  hitPolicy: 'UNIQUE',   out: 'action',  values: ACTION,
    inputs: ['verdict', 'evidenceClass', 'severity'] },
  { id: 'checkerFloor',       hitPolicy: 'PRIORITY', out: 'ceiling', values: CEILING,
    inputs: ['checkerStatus'] },
  { id: 'budgetAdmission',    hitPolicy: 'UNIQUE',   out: 'admission', values: ['admit', 'deny', 'deny-and-finding'],
    inputs: ['budgetStatus', 'leaseState', 'withinBudget', 'headroomRemaining'] },
  { id: 'replayAdmission',    hitPolicy: 'UNIQUE',   out: 'admission', values: ['admit', 'deny'],
    inputs: ['replayWithinCap', 'protocolCapability'] },
  { id: 'correctionCap',      hitPolicy: 'UNIQUE',   out: 'admission', values: ['issue', 'escalate-human'],
    inputs: ['correctionsBelowCap', 'protocolCapability'] },
  { id: 'injectionPermitted', hitPolicy: 'UNIQUE',   out: 'mechanism',
    values: ['transient-by-construction', 'replay-verbatim', 'leading-system-fold', 'not-permitted'],
    inputs: ['protocolCapability', 'betaHeaderAccepted', 'leaseState', 'partialTranscript'] },
  { id: 'injectionCadence',   hitPolicy: 'UNIQUE',   out: 'cadence', values: ['emit', 'suppress', 'emit-once'],
    inputs: ['labelSetStatus', 'disclosureState'] },
  { id: 'flipResponse',       hitPolicy: 'UNIQUE',   out: 'ceiling', values: CEILING,
    inputs: ['flipSignal', 'leaseState'] },
  { id: 'judgeReduction',     hitPolicy: 'UNIQUE',   out: 'ceiling', values: CEILING,
    inputs: ['judgeVerdict', 'judgeConfidence'] },
  { id: 'escalationReduce',   hitPolicy: 'PRIORITY', out: 'ceiling', values: CEILING,
    inputs: ['escalationSignal'] },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The unary-test cell text for one value of one input. */
function cellText(name, value) {
  const def = INPUTS[name];
  if (def.kind === 'enum') {
    return def.type === 'string' ? `"${value}"` : String(value);
  }
  if (def.kind === 'cmp') return String(value);            // true / false
  if (def.kind === 'int') return value.hi ? `< ${value.at}` : `>= ${value.at}`;
  throw new Error(`unknown input kind for ${name}`);
}

/** The probe values that enumerate an input's domain (Appendix A §A.2 for integers). */
export function domainOf(name) {
  const def = INPUTS[name];
  if (def.kind === 'enum') return def.values;
  if (def.kind === 'cmp') return [true, false];
  if (def.kind === 'int') {
    // partition points come from the table's own literals: [min,at) , [at,max]
    return def.partition.flatMap((at) => [{ hi: true, at, probe: at - 1 }, { hi: false, at, probe: at }]);
  }
  throw new Error(`unknown input kind for ${name}`);
}

/** The value to put in an evaluation context for a domain member. */
export function probeValue(name, member) {
  const def = INPUTS[name];
  if (def.kind === 'int') return member.probe;
  return member;
}

export function product(decision) {
  const domains = decision.inputs.map(domainOf);
  let acc = [[]];
  for (const d of domains) acc = acc.flatMap((p) => d.map((v) => [...p, v]));
  return acc;
}

/** Build one decision table's rules: complete and disjoint. */
function rulesFor(d) {
  return product(d).map((cell, ri) => {
    const entries = d.inputs.map((name, i) =>
      `        <inputEntry id="re_${d.id}_${ri}_${i}"><text>${esc(cellText(name, cell[i]))}</text></inputEntry>`).join('\n');
    const out = pickOutput(d.values, cell, d.inputs);
    const oe = `        <outputEntry id="oe_${d.id}_${ri}"><text>${esc(typeof out === 'string' ? `"${out}"` : String(out))}</text></outputEntry>`;
    return `      <rule id="r_${d.id}_${ri}">\n${entries}\n${oe}\n      </rule>`;
  }).join('\n');
}

function tableFor(d) {
  const ins = d.inputs.map((name, i) => {
    const def = INPUTS[name];
    const expr = def.kind === 'enum' ? name : def.expr;
    return `      <input id="i_${d.id}_${i}" label="${name}">
        <inputExpression id="ie_${d.id}_${i}" typeRef="${def.type}"><text>${esc(expr)}</text></inputExpression>
      </input>`;
  }).join('\n');
  const outValues = d.hitPolicy === 'PRIORITY'
    ? `<outputValues id="ov_${d.id}">${d.values.map((v) => `<text>"${v}"</text>`).join('')}</outputValues>`
    : '';
  return `    <decisionTable id="dt_${d.id}" hitPolicy="${d.hitPolicy}">
${ins}
      <output id="o_${d.id}" name="${d.out}" label="${d.out}" typeRef="string">${outValues}</output>
${rulesFor(d)}
    </decisionTable>`;
}

export function buildPolicyXml() {
  const used = new Set();
  DECISIONS.forEach((d) => d.inputs.forEach((n) => used.add(n)));
  // integer/comparison inputs also need their underlying numeric context values declared as inputs
  const numericBackers = ['labelSetTokens', 'budgetCapTokens', 'replayedInjectionTokens',
    'cumulativeCap', 'permanentCorrections', 'correctionCap'];

  const inputData = [...used].map((n) => {
    const def = INPUTS[n];
    const t = def.kind === 'enum' ? def.type : def.type;
    return `  <inputData id="in_${n}" name="${n}"><variable id="var_${n}" name="${n}" typeRef="${t}"/></inputData>`;
  }).concat(numericBackers.map((n) =>
    `  <inputData id="in_${n}" name="${n}"><variable id="var_${n}" name="${n}" typeRef="number"/></inputData>`)).join('\n');

  const decisions = DECISIONS.map((d) => {
    // a decision needs the declared inputs; cmp/int inputs also require their numeric backers
    const needed = new Set(d.inputs);
    d.inputs.forEach((n) => {
      const def = INPUTS[n];
      if (def.kind === 'cmp') for (const tok of def.expr.match(/[A-Za-z][A-Za-z0-9_]*/g) || []) {
        if (INPUTS[tok] === undefined) needed.add(tok);
      }
    });
    const irs = [...needed].map((n, i) =>
      `    <informationRequirement id="ir_${d.id}_${i}"><requiredInput href="#in_${n}"/></informationRequirement>`).join('\n');
    return `  <decision id="${d.id}" name="${d.id}">
${irs}
${tableFor(d)}
  </decision>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="observer-policy" name="observer-policy" namespace="http://observer/policy">
${inputData}
${decisions}
</definitions>
`;
}

export const BUNDLE_STATS = {
  decisions: DECISIONS.length,
  inputs: Object.keys(INPUTS).length,
  rules: DECISIONS.reduce((s, d) => s + product(d).length, 0),
  perDecision: Object.fromEntries(DECISIONS.map((d) => [d.id, product(d).length])),
};
