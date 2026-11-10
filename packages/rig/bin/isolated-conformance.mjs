#!/usr/bin/env node
/**
 * Isolated conformance runner — executes rig conformance runs in a PLAIN NODE
 * CHILD PROCESS, one batch per suite, marshalling NDJSON results back.
 *
 * WHY (lead decision 2026-11-10, §9.7 follow-through): the chunk-transit gate
 * (±5ms per chunk) stayed hard, but the measurement environment changed. In
 * long-lived vitest workers the gate saw ~0.4%/run single-chunk spikes of
 * 6-11ms attributable to worker starvation (heap/scheduling), while the SAME
 * gateway code in fresh child processes produced ZERO spikes across ~1050
 * samples. Removing the noise source beats tolerating it.
 *
 * TWO CONSEQUENCES THAT MUST STAY VISIBLE (lead's conditions):
 *  1. The ±5ms bound did NOT move and every chunk is still gated. What changed
 *     is the environment the measurement is taken in.
 *  2. Under child-process isolation, a transit spike is a REAL FINDING and must
 *     NEVER be reclassified as environmental. Isolation removes the
 *     environmental explanation — that is the whole justification for it. If a
 *     spike appears here, investigate the SUT, not the runner.
 *
 * The runner imports ONLY the rig (judge). The SUT arrives as a module path
 * (--sut-module) exporting a default factory ({captureOutDir?}) => Sut, so the
 * judge never depends on the judged.
 *
 * Usage: node bin/isolated-conformance.mjs --sut-module <path.mjs>
 *          [--fixtures all|id1,id2] [--capture-out <dir>]
 * Output: one NDJSON line per fixture on stdout; progress notes on stderr.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadCorpus, runFidelityCheck, formatReport, formatDiagnostics } from '../dist/index.js'

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

const sutModulePath = arg('sut-module', undefined)
if (!sutModulePath) {
  console.error('isolated-conformance: --sut-module <path.mjs> is required')
  process.exit(2)
}
const fixturesSpec = arg('fixtures', 'all')
const captureOutBase = arg('capture-out', undefined)
const corpusDir = arg('corpus-dir', undefined)

const mod = await import(pathToFileURL(path.resolve(sutModulePath)).href)
const makeSut = mod.default
if (typeof makeSut !== 'function') {
  console.error(`isolated-conformance: ${sutModulePath} must default-export a factory function`)
  process.exit(2)
}

const corpus = await loadCorpus(corpusDir ?? undefined)
let selected = corpus
if (fixturesSpec !== 'all') {
  const ids = new Set(fixturesSpec.split(',').map((s) => s.trim()))
  selected = corpus.filter((f) => ids.has(f.id))
  const missing = [...ids].filter((id) => !selected.some((f) => f.id === id))
  if (missing.length) {
    console.error(`isolated-conformance: fixtures not found: ${missing.join(', ')}`)
    process.exit(2)
  }
}

const ownTemp = captureOutBase === undefined
const captureOutDir = captureOutBase ?? mkdtempSync(path.join(tmpdir(), 'isolated-conformance-'))

const marshalSide = (side) => ({
  bodySha256: side.client.bodySha256,
  bodyBase64: side.client.body.length <= 1024 * 1024 ? side.client.body.toString('base64') : null,
  bodyLen: side.client.body.length,
  framingComplete: side.client.framingComplete,
  truncatedAtBodyByte: side.client.truncatedAtBodyByte ?? null,
  ttfbMs: side.client.ttfbMs ?? null,
  socketError: side.client.socketError ?? null,
  timedOut: side.client.timedOut,
  bodyEvents: side.client.bodyEvents.map((e) => ({ tMs: e.tMs, bytes: e.bytes, cumBytes: e.cumBytes })),
  head: side.client.head
    ? { statusCode: side.client.head.statusCode ?? null, reason: side.client.head.reason ?? '', headers: side.client.head.headers }
    : null,
  upstream: side.upstream
    ? {
        bodySha256: side.upstream.bodySha256,
        bodyComplete: side.upstream.bodyComplete,
        headerPairs: side.upstream.headerPairs,
        responseAborted: side.upstream.responseAborted ?? false,
        emitCount: (side.upstream.emitEvents ?? []).length,
      }
    : null,
})

console.error(`isolated-conformance: ${selected.length} fixture(s), sut=${sutModulePath}, pid=${process.pid}`)
for (const fixture of selected) {
  let line
  try {
    const sut = await makeSut({ captureOutDir })
    const report = await runFidelityCheck({ fixture, sut })
    // Optional per-fixture evidence from the SUT module (stats, injected-fault
    // counters) — how fail-open tests observe a poisoned recorder across the
    // process boundary.
    const evidence = typeof mod.collectEvidence === 'function' ? await mod.collectEvidence() : undefined
    line = {
      id: fixture.id,
      passed: report.passed,
      diffCount: report.diffs.length,
      report: report.passed ? null : formatReport(report, { timelines: true }),
      diagnosticsLine: formatDiagnostics(report).split('\n').map((l) => l.trim()).filter(Boolean).join(' | '),
      diagnostics: report.diagnostics,
      evidence: evidence ?? null,
      baseline: marshalSide(report.baseline),
      sut: marshalSide(report.sut),
    }
  } catch (err) {
    line = { id: fixture.id, passed: false, diffCount: -1, report: `runner exception: ${err instanceof Error ? err.stack : String(err)}`, diagnostics: null, evidence: null, baseline: null, sut: null }
  }
  console.log(JSON.stringify(line))
}

if (ownTemp) rmSync(captureOutDir, { recursive: true, force: true })
