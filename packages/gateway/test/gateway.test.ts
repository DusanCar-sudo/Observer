/**
 * V1 gateway: routing and byte-identity.
 *
 * The gateway is a POLICY layer over the shared proxy core (packages/capture/src/
 * proxy-core.ts). The core's byte fidelity is judged by the rig in that package;
 * what is judged here is only what the gateway adds — which paths forward, which
 * are refused, and that a forward mutates nothing (A1).
 *
 * A1's real detection gap (spec §4A.2): qwen applies no prefix check, so a body
 * mutation produces NO error — only cache loss. These tests are the only
 * detection there is, which is why byte-identity is asserted, not assumed.
 *
 * PROVENANCE NOTE (adoption per lead protocol, 2026-11-10): this file appeared
 * in the working tree with no recorded author (same unexplained-writer incident
 * as the capture-package files; see the extraction commit message). Reviewed
 * line by line and adopted with three adaptations to the shipped API and the
 * lead-approved spec: imports point at src/index.ts (decideRoute), config uses
 * captureOutDir, the synthetic-response marker is x-observer-gateway, and the
 * unknown-path expectation is 501 — spec §9.1's table says "everything else
 * including /v1/messages → 501" (a 404/501 split was the original author's
 * choice; the approved criterion chose uniform explicit refusal).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runClient, serializeHead, sha256, startMockUpstream } from '@observer/rig'
import { decideRoute as route, startGateway } from '../src/index.js'

const temps: string[] = []
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'observer-gateway-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

/** A body with the two things a typed proxy silently destroys. */
const TRICKY_BODY = Buffer.from(
  JSON.stringify({
    model: 'qwen',
    messages: [
      { role: 'assistant', content: '', reasoning_content: 'internal chain of thought', x_custom: { keep: [1, 2] } },
    ],
    stream: true,
    x_unknown_top_level: 'must survive',
  }),
  'utf8',
)

function reqHead(bytes: Buffer, target = '/v1/chat/completions'): Buffer {
  return serializeHead(`POST ${target} HTTP/1.1`, [
    ['host', '127.0.0.1:1'],
    ['content-type', 'application/json'],
    ['content-length', String(bytes.length)],
  ])
}

const okBody = Buffer.from('ok', 'latin1')
const okScript = {
  status: 200,
  reason: 'OK',
  headers: [] as [string, string][],
  framing: 'length' as const,
  writes: [{ payload: { inline: 'ok' }, delayMs: 0 }],
}

function headerOf(client: Awaited<ReturnType<typeof runClient>>, name: string): string | undefined {
  return client.head?.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1]
}

async function waitMeta(captureDir: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  for (;;) {
    try {
      return JSON.parse(readFileSync(path.join(captureDir, 'meta.json'), 'utf8')) as Record<string, unknown>
    } catch (err) {
      lastErr = err
      if (Date.now() > deadline) throw new Error(`meta.json not finalized: ${String(lastErr)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

describe('gateway routing', () => {
  it('forwards /v1/chat/completions byte-identically (A1) and captures it', async () => {
    const outDir = tempDir()
    const up = await startMockUpstream(okScript, [okBody])
    const gw = await startGateway({ upstreamOrigin: up.origin, captureOutDir: outDir, listenPort: 0, rewriteHost: false })
    try {
      const client = await runClient({ port: gw.port, headBytes: reqHead(TRICKY_BODY), body: TRICKY_BODY, timeoutMs: 10_000 })
      expect(client.head?.statusCode).toBe(200)
      expect(client.body.toString('latin1')).toBe('ok')

      // A1: what the upstream received is what the client sent. rewriteHost is
      // off, so the body must be identical with no exemption.
      expect(up.captures.length).toBe(1)
      expect(up.captures[0]!.bodySha256).toBe(sha256(TRICKY_BODY))

      const ids = gw.captureIds()
      const meta = await waitMeta(path.join(outDir, ids[0]!))
      expect(meta['status']).toBe('complete')
    } finally {
      await gw.stop()
      await up.stop()
    }
  }, 30_000)

  it('refuses /v1/responses with 501 unsupported-protocol and never contacts upstream', async () => {
    const outDir = tempDir()
    const up = await startMockUpstream(okScript, [okBody])
    const gw = await startGateway({ upstreamOrigin: up.origin, captureOutDir: outDir, listenPort: 0, rewriteHost: false })
    try {
      const client = await runClient({
        port: gw.port,
        headBytes: reqHead(TRICKY_BODY, '/v1/responses'),
        body: TRICKY_BODY,
        timeoutMs: 10_000,
      })
      expect(client.head?.statusCode).toBe(501)
      expect(client.body.toString('utf8')).toContain('unsupported-protocol')
      expect(headerOf(client, 'x-observer-gateway')).toBe('v1')
      expect(up.captures.length).toBe(0)

      // A refusal is still an observation: the request is on the record.
      const ids = gw.captureIds()
      const meta = await waitMeta(path.join(outDir, ids[0]!))
      expect(meta['status']).toBe('refused')
      expect(String(meta['error'])).toContain('unsupported-protocol')
    } finally {
      await gw.stop()
      await up.stop()
    }
  }, 30_000)
})

describe('route() is a pure function', () => {
  const info = (target: string) => ({
    method: 'POST',
    target,
    httpVersion: 'HTTP/1.1',
    headerPairs: [] as [string, string][],
    headBytes: Buffer.alloc(0),
  })

  it('forwards the chat completions path, with or without a query string', () => {
    expect(route(info('/v1/chat/completions')).kind).toBe('forward')
    expect(route(info('/v1/chat/completions?x=1')).kind).toBe('forward')
  })

  it('refuses every unimplemented protocol explicitly rather than best-efforting it', () => {
    for (const t of ['/v1/responses', '/v1/messages', '/v1/embeddings']) {
      const d = route(info(t))
      expect(d.kind).toBe('refuse')
      if (d.kind === 'refuse') expect(d.response.status).toBe(501)
    }
  })

  it('unknown paths get the same explicit 501 — spec §9.1: everything else → 501, uniformly', () => {
    const d = route(info('/nope'))
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') expect(d.response.status).toBe(501)
  })
})
