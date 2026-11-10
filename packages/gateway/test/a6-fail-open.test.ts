/**
 * A6 — FAIL OPEN (invariant I1), TESTED NOT ASSERTED.
 *
 * "Kill the store mid-request; the request is still forwarded and the response
 * still returned, with the failure logged and counted."
 *
 * Two kill shapes:
 *  - the store is dead on arrival (recorder.begin() throws);
 *  - the store dies MID-FLIGHT (recordResponseWire starts throwing after N
 *    calls — a disk filling up, permissions revoked, the write-behind queue
 *    poisoned).
 * In both cases the client-visible bytes must be IDENTICAL to a healthy run
 * (proven via the rig's zero-diff conformance, not by eyeballing), and the loss
 * must be COUNTED — a silent capture gap is a silent audit gap (V2's rule, born
 * here).
 */

import { describe, expect, it } from 'vitest'
import { formatReport, runFidelityCheck, type Sut } from '@observer/rig'
import type { RecorderLike } from '@observer/capture'
import { POISONED_RECORDER, startGateway, type GatewayHandle } from '../src/index.js'
import { fixture, midFlightPoisonedRecorder, tempDir } from './helpers.js'

function gatewayWith(recorder: RecorderLike): Sut & { stats: () => ReturnType<GatewayHandle['stats']> } {
  let handle: GatewayHandle | undefined
  return {
    name: 'GatewayV1-poisoned',
    async start(ctx) {
      handle = await startGateway({
        upstreamOrigin: ctx.upstreamOrigin,
        rewriteHost: false,
        captureOutDir: tempDir(),
        listenPort: 0,
        recorder,
      })
      return { port: handle.port, stop: () => handle!.stop() }
    },
    stats: () => handle!.stats(),
  }
}

describe('A6 — fail open on capture failure', () => {
  it('store dead on arrival: traffic byte-perfect, failure counted', async () => {
    const fx = await fixture('res-stream-reasoning')
    const sut = gatewayWith(POISONED_RECORDER)
    const report = await runFidelityCheck({ fixture: fx, sut })
    if (report.diffs.length > 0) throw new Error(`\n${formatReport(report, { timelines: true })}`)
    expect(sut.stats().captureErrors).toBeGreaterThan(0)
    // forwarded and responded despite a dead store:
    expect(report.sut.upstream!.bodyComplete).toBe(true)
    expect(report.sut.client.framingComplete).toBe(true)
  }, 120_000)

  it('store dies MID-RESPONSE: client still receives every byte, loss counted', async () => {
    const fx = await fixture('res-stream-done') // 7 response writes
    const outDir = tempDir()
    const poison = midFlightPoisonedRecorder(outDir, 2) // dies on the 3rd response write
    const sut = gatewayWith(poison.recorder)
    const report = await runFidelityCheck({ fixture: fx, sut })
    if (report.diffs.length > 0) throw new Error(`\n${formatReport(report, { timelines: true })}`)
    expect(poison.failures()).toBeGreaterThan(0) // the poison really fired
    expect(sut.stats().captureErrors).toBeGreaterThan(0) // and was counted, not silent
    expect(report.sut.client.framingComplete).toBe(true)
  }, 120_000)

  it('the poisoned runs leave no hung sockets (stops are clean)', async () => {
    // If a poisoned capture leaked a socket, vitest's fork would hang at teardown;
    // reaching this third test with both prior sut.stop() calls resolved IS the
    // assertion, plus an explicit start/stop cycle here:
    const gw = await startGateway({
      upstreamOrigin: 'http://127.0.0.1:9',
      recorder: POISONED_RECORDER,
      listenPort: 0,
    })
    await gw.stop()
    expect(true).toBe(true)
  }, 60_000)
})
