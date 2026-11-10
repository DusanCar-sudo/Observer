/**
 * The V1 policy seam on the shared proxy core.
 *
 * The core exists so that byte fidelity is implemented once and judged once. What
 * it ADDS over the V0a tap is `route()`: one decision per request head, either
 * 'forward' or 'refuse' with a synthetic response. This file judges exactly that
 * addition, and — the part that matters — that a refusal is still an OBSERVATION:
 * the request is captured, the upstream never sees it, and the client gets a
 * synthetic response that is visibly not the provider's.
 *
 * A refusal that left no capture would be a hole in the witness, which is the one
 * thing this project cannot afford.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runClient, serializeHead, startMockUpstream } from '@observer/rig'
import { startProxy } from '../src/proxy-core.js'
import type { ProxyEvent } from '../src/proxy-core.js'
import type { CaptureMeta } from '../src/types.js'

const temps: string[] = []
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'observer-proxy-core-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

async function waitMeta(captureDir: string, timeoutMs = 10_000): Promise<CaptureMeta> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  for (;;) {
    try {
      return JSON.parse(readFileSync(path.join(captureDir, 'meta.json'), 'utf8')) as CaptureMeta
    } catch (err) {
      lastErr = err
      if (Date.now() > deadline) {
        throw new Error(`meta.json not finalized within ${timeoutMs}ms: ${String(lastErr)}`)
      }
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

/** Case-insensitive header lookup on the observed response head. */
function headerOf(client: Awaited<ReturnType<typeof runClient>>, name: string): string | undefined {
  return client.head?.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1]
}

const head = serializeHead('POST /v1/chat/completions HTTP/1.1', [
  ['host', '127.0.0.1:1'],
  ['content-type', 'application/json'],
  ['content-length', '2'],
])
const reqBody = Buffer.from('{}', 'latin1')

describe('proxy core route() seam', () => {
  it('refuses without contacting upstream, still captures the request', async () => {
    const outDir = tempDir()
    const okBody = Buffer.from('ok', 'latin1')
    const up = await startMockUpstream(
      {
        status: 200,
        reason: 'OK',
        headers: [],
        framing: 'length',
        writes: [{ payload: { inline: 'ok' }, delayMs: 0 }],
      },
      [okBody],
    )
    const events: ProxyEvent[] = []
    let seenTarget: string | undefined

    const proxy = await startProxy({
      upstreamOrigin: up.origin,
      outDir,
      listenPort: 0,
      rewriteHost: false,
      label: 'gateway-test',
      route: (info) => {
        seenTarget = info.target
        return {
          kind: 'refuse',
          reason: 'test-policy',
          response: { status: 403, reason: 'Forbidden', body: 'blocked by test policy' },
        }
      },
      onEvent: (ev) => events.push(ev),
    })

    try {
      const client = await runClient({ port: proxy.port, headBytes: head, body: reqBody, timeoutMs: 10_000 })
      expect(client.head?.statusCode).toBe(403)
      expect(client.body.toString('utf8')).toBe('blocked by test policy')
      // The marker names the layer that generated the response, so a client can
      // tell an Observer refusal from a provider one.
      expect(headerOf(client, 'x-observer-tap')).toBe('gateway-test')

      // The upstream must never have seen the request.
      expect(up.captures.length).toBe(0)

      // The router saw the real target, not a rewritten one.
      expect(seenTarget).toBe('/v1/chat/completions')

      // And the refusal is on the record.
      const ids = proxy.captureIds()
      expect(ids.length).toBe(1)
      const meta = await waitMeta(path.join(outDir, ids[0]!))
      expect(meta.status).toBe('refused')
      expect(meta.error).toContain('test-policy')
      expect(meta.request.bodySha256).toBe(
        // sha256 of "{}" — the body was recorded verbatim despite the refusal
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      )
      expect(events).toContainEqual(expect.objectContaining({ kind: 'refused', reason: 'test-policy' }))
    } finally {
      await proxy.stop()
      await up.stop()
    }
  }, 30_000)

  it('forwards when the policy says forward, and records normally', async () => {
    const outDir = tempDir()
    const okBody = Buffer.from('ok', 'latin1')
    const up = await startMockUpstream(
      {
        status: 200,
        reason: 'OK',
        headers: [],
        framing: 'length',
        writes: [{ payload: { inline: 'ok' }, delayMs: 0 }],
      },
      [okBody],
    )
    const proxy = await startProxy({
      upstreamOrigin: up.origin,
      outDir,
      listenPort: 0,
      rewriteHost: false,
      route: () => ({ kind: 'forward' }),
    })
    try {
      const client = await runClient({ port: proxy.port, headBytes: head, body: reqBody, timeoutMs: 10_000 })
      expect(client.head?.statusCode).toBe(200)
      expect(client.body.toString('utf8')).toBe('ok')
      expect(up.captures.length).toBe(1)
      const ids = proxy.captureIds()
      const meta = await waitMeta(path.join(outDir, ids[0]!))
      expect(meta.status).toBe('complete')
    } finally {
      await proxy.stop()
      await up.stop()
    }
  }, 30_000)
})
