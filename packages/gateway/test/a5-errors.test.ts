/**
 * A5 — ERRORS PASS THROUGH UNCHANGED, and Observer's own failures are
 * DISTINGUISHABLE from the provider's.
 *
 * "including non-JSON bodies, 429 with retry-after, and upstream connection
 * failures surfaced as a distinguishable Observer error (not a 500 that looks
 * like the provider's)."
 */

import { describe, expect, it } from 'vitest'
import { formatReport, runClient, runFidelityCheck, serializeHead, sha256 } from '@observer/rig'
import { startGateway, type GatewayHandle } from '../src/index.js'
import { fixture, gatewaySut, tempDir, waitMeta } from './helpers.js'
import path from 'node:path'

describe('A5 — provider errors pass through byte-identically', () => {
  for (const id of ['res-429-json', 'res-400-json-invalid', 'res-502-nonjson']) {
    it(
      `${id}: status, reason, headers, and body bytes identical to direct`,
      async () => {
        const fx = await fixture(id)
        const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
        if (report.diffs.length > 0) throw new Error(`\n${formatReport(report, { timelines: true })}`)
        expect(report.sut.client.bodySha256).toBe(sha256(Buffer.concat(fx.response.payloads)))
      },
      60_000,
    )
  }

  it('the 502 NON-JSON body stays non-JSON (no error-body "improvement")', async () => {
    const fx = await fixture('res-502-nonjson')
    const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
    const body = report.sut.client.body.toString('utf8')
    expect(body).toContain('<html>')
    expect(body).toContain('nginx')
    expect(() => {
      // must NOT be parseable as JSON — it is the provider's HTML, verbatim
      const t = body.trim()
      if (!(t.startsWith('{') || t.startsWith('['))) throw new Error('not json')
    }).toThrow()
  }, 60_000)
})

describe('A5 — upstream connection failure is a distinguishable OBSERVER error', () => {
  it('502 + x-observer-gateway marker + text/plain (never a provider-shaped JSON 500)', async () => {
    // port 9 (discard): nothing listens, connect fails fast with ECONNREFUSED
    const gw = await startGateway({
      upstreamOrigin: 'http://127.0.0.1:9',
      captureOutDir: tempDir(),
      listenPort: 0,
      rewriteHost: false,
    })
    try {
      const body = Buffer.from('{}')
      const head = serializeHead('POST /v1/chat/completions HTTP/1.1', [
        ['host', 'qwen-api.invalid'],
        ['content-type', 'application/json'],
        ['content-length', String(body.length)],
        ['connection', 'close'],
      ])
      const client = await runClient({ port: gw.port, headBytes: head, body, timeoutMs: 20_000 })
      expect(client.head?.statusCode).toBe(502)
      const headers = new Map(client.head!.headers.map(([n, v]) => [n.toLowerCase(), v]))
      // Distinguishable: carries the Observer marker and is NOT JSON
      expect(headers.get('x-observer-gateway')).toBe('v1')
      expect(headers.get('content-type')).toContain('text/plain')
      const text = client.body.toString('utf8')
      expect(text).toContain('observer gateway')
      expect(text).toContain('upstream connect failed')
      expect(text.trim().startsWith('{')).toBe(false)
      // counted, not silent
      expect(gw.stats().upstreamConnectFailed).toBe(1)
      // and recorded: the failed exchange is on the capture record with an honest status
      const ids = gw.captureIds()
      expect(ids).toHaveLength(1)
      const meta = await waitMeta(path.join(tempDirOf(gw), ids[0]!))
      expect(meta.status).toBe('incomplete:upstream-connect-failed')
    } finally {
      await gw.stop()
    }
  }, 60_000)
})

function tempDirOf(gw: GatewayHandle): string {
  if (!gw.outDir) throw new Error('gateway has no capture outDir')
  return gw.outDir
}
