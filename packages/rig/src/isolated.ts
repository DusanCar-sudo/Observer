/**
 * Client-side helper for the isolated conformance runner (bin/isolated-conformance.mjs).
 *
 * Spawns ONE plain-node child process per suite (batched execution, lead decision
 * 2026-11-10) and marshals per-fixture results back. The two standing conditions:
 *
 *  1. The ±5ms chunk-transit bound does NOT move and every chunk stays gated —
 *     isolation changes the ENVIRONMENT the measurement is taken in, nothing else.
 *  2. Under isolation, a transit spike is a REAL FINDING. It must never be
 *     reclassified as environmental: removing the environmental explanation is
 *     the entire justification for isolation. If a spike appears in child-run
 *     output, investigate the SUT, not the runner.
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HeaderPairs, TimingDiagnostics } from './types.js'

export interface IsolatedSide {
  bodySha256: string
  /** base64 of the decoded body when <= 1 MiB, else null (sha still present). */
  bodyBase64: string | null
  bodyLen: number
  framingComplete: boolean
  truncatedAtBodyByte: number | null
  ttfbMs: number | null
  socketError: string | null
  timedOut: boolean
  bodyEvents: { tMs: number; bytes: number; cumBytes: number }[]
  head: { statusCode: number | null; reason: string; headers: HeaderPairs } | null
  upstream: {
    bodySha256: string
    bodyComplete: boolean
    headerPairs: HeaderPairs
    responseAborted: boolean
    emitCount: number
  } | null
}

export interface IsolatedRunResult {
  id: string
  passed: boolean
  diffCount: number
  /** Formatted report when failed (offsets, hex, timelines, diagnostics). */
  report: string | null
  diagnosticsLine: string | null
  diagnostics: TimingDiagnostics | null
  /** Whatever the SUT module's optional collectEvidence() returned for this fixture. */
  evidence?: unknown
  baseline: IsolatedSide | null
  sut: IsolatedSide | null
}

export interface IsolatedConformanceOptions {
  /** Absolute path to a module default-exporting (opts:{captureOutDir}) => Sut | Promise<Sut>. */
  sutModule: string
  /** Fixture ids, or 'all' (default). */
  fixtures?: string[] | 'all'
  /** Corpus directory (default: the standard fixtures/corpus). */
  corpusDir?: string
  /** Capture dir for the SUT factory (default: runner-managed temp). */
  captureOutDir?: string
  timeoutMs?: number
}

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'isolated-conformance.mjs')

export function runIsolatedConformance(opts: IsolatedConformanceOptions): Promise<IsolatedRunResult[]> {
  const args = [RUNNER, '--sut-module', opts.sutModule]
  const fixtures = opts.fixtures ?? 'all'
  args.push('--fixtures', fixtures === 'all' ? 'all' : fixtures.join(','))
  if (opts.captureOutDir !== undefined) args.push('--capture-out', opts.captureOutDir)
  if (opts.corpusDir !== undefined) args.push('--corpus-dir', opts.corpusDir)
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 900_000 },
      (err, stdout, stderr) => {
        if (stderr) process.stderr.write(stderr) // runner progress + per-fixture diagnostics to the CI log
        if (err) {
          reject(new Error(`isolated conformance child failed: ${err.message}\n${stdout.slice(-4000)}`))
          return
        }
        try {
          const results = stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as IsolatedRunResult)
          resolve(results)
        } catch (e) {
          reject(new Error(`isolated conformance output not NDJSON: ${String(e)}\n${stdout.slice(0, 2000)}`))
        }
      },
    )
  })
}
