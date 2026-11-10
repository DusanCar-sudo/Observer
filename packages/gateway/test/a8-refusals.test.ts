/**
 * A8 — REFUSE WHAT WE DO NOT SUPPORT (corrected criterion, spec §9.1).
 *
 * Refusals key ONLY on signals message content cannot spoof: the request path
 * and the anthropic-version header. Body-shape refusal is deliberately SOFT in
 * milestone 1 (recorded + counted, never enforced) because a substring scan
 * would 501 any session that merely discusses Anthropic's schema — the
 * supervisor breaking the supervised agent over conversation content.
 *
 * Every refusal here must also satisfy I2: it is captured (status 'refused'),
 * counted in stats (visible, not just logged — §9.1 condition 1), and marked
 * with the x-observer-gateway header so no client can mistake it for a
 * provider error.
 */

import { describe, expect, it } from 'vitest'
import { runClient, serializeHead, startMockUpstream } from '@observer/rig'
import { startGateway, type GatewayHandle } from '../src/index.js'
import { fixture, tempDir, waitMeta } from './helpers.js'
import path from 'node:path'

async function withGateway(fn: (gw: GatewayHandle, upstreamCaptures: () => number) => Promise<void>): Promise<void> {
  const fx = await fixture('res-nonstream-json')
  const up = await startMockUpstream(fx.response.script, fx.response.payloads)
  const gw = await startGateway({
    upstreamOrigin: up.origin,
    rewriteHost: false,
    captureOutDir: tempDir(),
    listenPort: 0,
  })
  try {
    await fn(gw, () => up.captures.length)
  } finally {
    await gw.stop()
    await up.stop()
  }
}

function requestHead(method: string, target: string, bodyLen: number, extra: [string, string][] = []): Buffer {
  return serializeHead(`${method} ${target} HTTP/1.1`, [
    ['host', 'qwen-api.invalid'],
    ['content-type', 'application/json'],
    ...extra,
    ['content-length', String(bodyLen)],
    ['connection', 'close'],
  ])
}

const SMALL_BODY = Buffer.from('{"model":"qwen3.8-max","messages":[]}')

async function expect501(gw: GatewayHandle, method: string, target: string, extra: [string, string][] = []): Promise<void> {
  const client = await runClient({
    port: gw.port,
    headBytes: requestHead(method, target, SMALL_BODY.length, extra),
    body: SMALL_BODY,
    timeoutMs: 15_000,
  })
  expect(client.head?.statusCode, `${method} ${target}`).toBe(501)
  const headers = new Map(client.head!.headers.map(([n, v]) => [n.toLowerCase(), v]))
  expect(headers.get('x-observer-gateway')).toBe('v1')
  expect(client.framingComplete).toBe(true)
  expect(client.body.toString('utf8')).toContain('unsupported')
}

describe('A8 — hard refusals on content-unspoofable signals', () => {
  it('/v1/responses → explicit 501 unsupported-protocol (spec-named)', async () => {
    await withGateway(async (gw, upstreamCaptures) => {
      const client = await runClient({
        port: gw.port,
        headBytes: requestHead('POST', '/v1/responses', SMALL_BODY.length),
        body: SMALL_BODY,
        timeoutMs: 15_000,
      })
      expect(client.head?.statusCode).toBe(501)
      const body = client.body.toString('utf8')
      expect(body).toContain('"code":"unsupported-protocol"')
      expect(body).toContain('POST /v1/chat/completions')
      // refused traffic NEVER reaches the upstream
      expect(upstreamCaptures()).toBe(0)
      // and the refusal is on the record (I2)
      const ids = gw.captureIds()
      const meta = await waitMeta(path.join(gw.outDir!, ids[ids.length - 1]!))
      expect(meta.status).toBe('refused')
      expect(meta.error).toContain('unsupported-protocol')
      expect(gw.stats().refused['unsupported-protocol']).toBe(1)
    })
  }, 60_000)

  it('/v1/messages (Anthropic SDK path, verified [SRC]) → 501', async () => {
    await withGateway(async (gw, upstreamCaptures) => {
      await expect501(gw, 'POST', '/v1/messages')
      expect(upstreamCaptures()).toBe(0)
    })
  }, 60_000)

  it('anthropic-version header on the SUPPORTED path → 501 (header beats path)', async () => {
    await withGateway(async (gw, upstreamCaptures) => {
      await expect501(gw, 'POST', '/v1/chat/completions', [['anthropic-version', '2023-06-01']])
      expect(upstreamCaptures()).toBe(0)
      expect(gw.stats().refused['anthropic-version-header']).toBe(1)
    })
  }, 60_000)

  it('wrong method on the supported path → 501', async () => {
    await withGateway(async (gw) => {
      await expect501(gw, 'GET', '/v1/chat/completions')
      expect(gw.stats().refused['unsupported-method']).toBe(1)
    })
  }, 60_000)

  it('unknown paths → 501 (query strings do not smuggle a route)', async () => {
    await withGateway(async (gw) => {
      await expect501(gw, 'POST', '/v1/embeddings')
      await expect501(gw, 'POST', '/v1/chat/completions/../responses')
      await expect501(gw, 'POST', '/v1/chat/completionsX')
      expect(gw.stats().forwarded).toBe(0)
    })
  }, 60_000)

  it('the supported route still forwards (refusals are not the default)', async () => {
    await withGateway(async (gw, upstreamCaptures) => {
      const client = await runClient({
        port: gw.port,
        headBytes: requestHead('POST', '/v1/chat/completions', SMALL_BODY.length),
        body: SMALL_BODY,
        timeoutMs: 15_000,
      })
      expect(client.head?.statusCode).toBe(200)
      expect(upstreamCaptures()).toBe(1)
      expect(gw.stats().forwarded).toBe(1)
    })
  }, 60_000)

  it('a large refused request is DRAINED, so the client reliably receives the 501 (no RST eating our own response)', async () => {
    await withGateway(async (gw) => {
      const big = Buffer.alloc(1024 * 1024, 0x61)
      const client = await runClient({
        port: gw.port,
        headBytes: requestHead('POST', '/v1/responses', big.length),
        body: big,
        timeoutMs: 15_000,
      })
      expect(client.head?.statusCode).toBe(501)
      expect(client.framingComplete).toBe(true)
      expect(client.socketError ?? '').not.toContain('ECONNRESET')
      // the drained body was still recorded (I2: refusals are observed too)
      const ids = gw.captureIds()
      const meta = await waitMeta(path.join(gw.outDir!, ids[ids.length - 1]!))
      expect(meta.request.bodyBytes).toBe(big.length)
    })
  }, 60_000)
})

describe('A8 — §9.1 condition 2: no pretending at unimplementable enforcement', () => {
  it('refuseOnBodyShape=true FAILS STARTUP in milestone 1 (no parser exists yet)', async () => {
    await expect(
      startGateway({ upstreamOrigin: 'http://127.0.0.1:9', refuseOnBodyShape: true, listenPort: 0 }),
    ).rejects.toThrow(/not implementable in milestone 1/)
  }, 30_000)

  it('refuseOnBodyShape unset/false starts fine (default OFF)', async () => {
    const gw = await startGateway({ upstreamOrigin: 'http://127.0.0.1:9', listenPort: 0, captureOutDir: tempDir() })
    await gw.stop()
    const gw2 = await startGateway({ upstreamOrigin: 'http://127.0.0.1:9', refuseOnBodyShape: false, listenPort: 0, captureOutDir: tempDir() })
    await gw2.stop()
  }, 30_000)
})
