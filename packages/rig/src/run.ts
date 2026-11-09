/**
 * The differential fidelity check: run one fixture twice — direct to the mock
 * upstream (baseline) and via the system-under-test — then diff everything that
 * fidelity means: status, headers, body bytes with offsets, what the upstream saw,
 * arrival boundaries, inter-arrival gaps (vs baseline AND vs the script's nominal
 * schedule), TTFB delta, and truncation offsets.
 *
 * The two runs are strictly sequential and each gets a FRESH upstream instance on a
 * fresh ephemeral loopback port, so nothing (keep-alive state, capture buffers,
 * timing debt) leaks between them, and the differential cancels machine-level noise
 * that hits both runs alike.
 */

import { performance } from 'node:perf_hooks'
import { runClient } from './client.js'
import { diffRuns } from './diff.js'
import { startMockUpstream } from './upstream.js'
import type { FidelityDiff, FidelityRunOptions, FidelityRunReport, RunSide } from './types.js'

export async function runFidelityCheck(opts: FidelityRunOptions): Promise<FidelityRunReport> {
  const started = performance.now()
  const { fixture } = opts
  const clientTimeoutMs = opts.clientTimeoutMs ?? 30_000
  const diffs: FidelityDiff[] = []

  // ---------- baseline run: client -> upstream (direct) ----------
  const upA = await startMockUpstream(fixture.response.script, fixture.response.payloads)
  let baseline: RunSide
  try {
    const client = await runClient({
      port: upA.port,
      headBytes: fixture.request.headBytes,
      body: fixture.request.body,
      timeoutMs: clientTimeoutMs,
    })
    baseline = { client, upstream: upA.captures[0] }
  } finally {
    await upA.stop()
  }

  // ---------- SUT run: client -> SUT -> upstream ----------
  const upB = await startMockUpstream(fixture.response.script, fixture.response.payloads)
  let sut: RunSide
  let sutHandle: { port: number; stop(): Promise<void> } | undefined
  try {
    sutHandle = await opts.sut.start({ upstreamOrigin: upB.origin, upstreamPort: upB.port })
    const client = await runClient({
      port: sutHandle.port,
      headBytes: fixture.request.headBytes,
      body: fixture.request.body,
      timeoutMs: clientTimeoutMs,
    })
    sut = { client, upstream: upB.captures[0] }
  } catch (err) {
    sut = {
      client: {
        requestBytesWritten: 0,
        wireEvents: [],
        bodyEvents: [],
        body: Buffer.alloc(0),
        bodySha256: '',
        framingComplete: false,
        timedOut: false,
        aborted: false,
        totalMs: 0,
      },
      upstream: upB.captures[0],
    }
    diffs.push({ kind: 'protocol', side: 'sut', detail: `SUT failed to start: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    if (sutHandle) await sutHandle.stop()
    await upB.stop()
  }

  diffs.push(...diffRuns(fixture, baseline, sut, { headerIgnore: opts.headerIgnore, timing: opts.timing }))

  return {
    fixtureId: fixture.id,
    sutName: opts.sut.name,
    passed: diffs.length === 0,
    diffs,
    baseline,
    sut,
    durationMs: performance.now() - started,
  }
}
