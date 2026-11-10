/**
 * Shared test scaffolding for the gateway suite.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { loadCorpus, runClient, startMockUpstream, type ClientResult, type MockUpstream, type ResolvedFixture, type Sut } from '@observer/rig'
import { CaptureRecorder, type CaptureMeta, type RecorderLike } from '@observer/capture'
import { startGateway, type GatewayConfig, type GatewayHandle } from '../src/index.js'

const temps: string[] = []

export function tempDir(prefix = 'observer-gw-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  temps.push(d)
  return d
}

afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

let corpusCache: ResolvedFixture[] | undefined

export async function corpus(): Promise<ResolvedFixture[]> {
  corpusCache ??= await loadCorpus()
  return corpusCache
}

export async function fixture(id: string): Promise<ResolvedFixture> {
  const c = await corpus()
  const f = c.find((x) => x.id === id)
  if (!f) throw new Error(`fixture ${id} missing from corpus`)
  return f
}

/** Gateway as a rig SUT. `outDir` collects captures; rewriteHost off for byte-exact conformance. */
export function gatewaySut(extra: Omit<Partial<GatewayConfig>, 'upstreamOrigin'> = {}): Sut & { lastHandle(): GatewayHandle | undefined } {
  let handle: GatewayHandle | undefined
  return {
    name: 'GatewayV1',
    async start(ctx) {
      handle = await startGateway({
        upstreamOrigin: ctx.upstreamOrigin,
        rewriteHost: false,
        captureOutDir: tempDir(),
        listenPort: 0,
        ...extra,
      })
      return { port: handle.port, stop: () => handle!.stop() }
    },
    lastHandle: () => handle,
  }
}

export interface ExchangeResult {
  client: ClientResult
  upstream: MockUpstream['captures'][number] | undefined
  meta: CaptureMeta | undefined
  stats: GatewayHandle extends never ? never : ReturnType<GatewayHandle['stats']>
  captureDir: string | undefined
}

/** One managed request through a fresh gateway+upstream pair. */
export async function exchangeViaGateway(
  fx: ResolvedFixture,
  cfg: Omit<Partial<GatewayConfig>, 'upstreamOrigin'> = {},
): Promise<ExchangeResult> {
  const outDir = tempDir()
  const up = await startMockUpstream(fx.response.script, fx.response.payloads)
  const gw = await startGateway({
    upstreamOrigin: up.origin,
    rewriteHost: false,
    captureOutDir: outDir,
    listenPort: 0,
    ...cfg,
  })
  try {
    const client = await runClient({ port: gw.port, headBytes: fx.request.headBytes, body: fx.request.body, timeoutMs: 30_000 })
    const ids = gw.captureIds()
    const captureDir = ids.length > 0 ? path.join(outDir, ids[ids.length - 1]!) : undefined
    const meta = captureDir ? await waitMeta(captureDir).catch(() => undefined) : undefined
    return { client, upstream: up.captures[0], meta, stats: gw.stats(), captureDir }
  } finally {
    await gw.stop()
    await up.stop()
  }
}

/** Capture finalization is write-behind by design; tests wait (bounded) for meta.json. */
export async function waitMeta(captureDir: string, timeoutMs = 10_000): Promise<CaptureMeta> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  for (;;) {
    try {
      return JSON.parse(readFileSync(path.join(captureDir, 'meta.json'), 'utf8')) as CaptureMeta
    } catch (err) {
      lastErr = err
      if (Date.now() > deadline) throw new Error(`meta.json not finalized within ${timeoutMs}ms: ${String(lastErr)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

/** Recorder wrapper that starts healthy, then throws from recordResponseWire after N calls. */
export function midFlightPoisonedRecorder(outDir: string, failAfter: number): { recorder: RecorderLike; failures: () => number } {
  const real = new CaptureRecorder(outDir)
  let failures = 0
  return {
    recorder: {
      begin() {
        const c = real.begin()
        let calls = 0
        return {
          ...c,
          recordResponseWire(chunk: Buffer, t: number) {
            if (++calls > failAfter) {
              failures++
              throw new Error('poisoned stream write (A6 mid-flight)')
            }
            c.recordResponseWire(chunk, t)
          },
        }
      },
    },
    failures: () => failures,
  }
}
