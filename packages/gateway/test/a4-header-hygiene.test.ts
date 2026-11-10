/**
 * A4 — HEADER HYGIENE.
 *
 * "Hop-by-hop headers stripped; content-length handled correctly for the
 * transfer mode used; auth and provider headers forwarded unchanged; no header
 * added, renamed, or reordered."
 *
 * The gateway forwards RAW head bytes, so "no header added, renamed, or
 * reordered" is structural: the only head surgery is (1) byte-level excision of
 * hop-by-hop LINES and (2) the Host value splice (disabled in conformance).
 * These tests assert that at the byte level against what the upstream saw, and
 * on the response side against what the client saw.
 */

import { describe, expect, it } from 'vitest'
import { formatReport, isHopByHop, runFidelityCheck } from '@observer/rig'
import { exchangeViaGateway, fixture, gatewaySut } from './helpers.js'

describe('A4 — request headers toward the upstream', () => {
  it('hop-by-hop lines excised; every other pair byte-identical, same order, same casing', async () => {
    const fx = await fixture('res-nonstream-json')
    const r = await exchangeViaGateway(fx)
    const seen = r.upstream!.headerPairs
    const expected = fx.request.headerPairs.filter(([n]) => !isHopByHop(n))
    expect(seen).toEqual(expected) // ordered, cased, exact values
    // the fixture DOES carry a hop header, so the strip is exercised, not vacuous
    expect(fx.request.headerPairs.some(([n]) => isHopByHop(n))).toBe(true)
    expect(seen.some(([n]) => isHopByHop(n))).toBe(false)
  }, 60_000)

  it('auth and provider headers are forwarded unchanged (authorization, openai-*, x-stainless-*)', async () => {
    const fx = await fixture('res-nonstream-json')
    const r = await exchangeViaGateway(fx)
    const seen = new Map(r.upstream!.headerPairs.map(([n, v]) => [n.toLowerCase(), v]))
    const sent = new Map(fx.request.headerPairs.map(([n, v]) => [n.toLowerCase(), v]))
    for (const name of ['authorization', 'openai-organization', 'openai-project', 'x-stainless-lang', 'x-stainless-retry-count', 'content-type', 'content-length']) {
      expect(seen.get(name), `${name} forwarded`).toBe(sent.get(name))
    }
  }, 60_000)
})

describe('A4 — response headers toward the client', () => {
  it('nothing added, renamed, or reordered; provider x-* headers intact', async () => {
    const fx = await fixture('res-headers-passthrough')
    const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
    if (report.diffs.length > 0) throw new Error(`\n${formatReport(report, { timelines: true })}`)
    const clientSaw = new Map(report.sut.client.head!.headers.map(([n, v]) => [n.toLowerCase(), v]))
    expect(clientSaw.get('x-request-id')).toBe('req_obs_fixture_7f3a91c2')
    expect(clientSaw.get('x-trace-id')).toBe('trace-obs-9c2e41b7')
    expect(clientSaw.get('x-ratelimit-remaining-tokens')).toBe('98765')
    expect(clientSaw.get('cache-control')).toBe('no-store')
    // no observer marker leaks into forwarded provider responses
    expect(clientSaw.has('x-observer-gateway')).toBe(false)
    expect(clientSaw.has('x-powered-by')).toBe(false)
  }, 60_000)

  it('429 retry-after reaches the client unchanged (SDK retry behaviour depends on it)', async () => {
    const fx = await fixture('res-429-json')
    const report = await runFidelityCheck({ fixture: fx, sut: gatewaySut() })
    if (report.diffs.length > 0) throw new Error(`\n${formatReport(report, { timelines: true })}`)
    const clientSaw = report.sut.client.head!.headers
    expect(clientSaw.find(([n]) => n.toLowerCase() === 'retry-after')?.[1]).toBe('2')
    expect(report.sut.client.head!.statusCode).toBe(429)
    expect(report.sut.client.head!.reason).toBe('Too Many Requests')
  }, 60_000)
})
