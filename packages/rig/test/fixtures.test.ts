/**
 * Corpus integrity and ACCEPTANCE-CRITERION COVERAGE tests.
 *
 * The coverage assertions encode task-1's fixture requirements as executable checks,
 * so the corpus cannot silently shrink below what V1/V4/V5 acceptance depends on.
 * The tamper test proves the integrity machinery actually fires — a hash check that
 * has never failed is a claim, not a control.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FixtureIntegrityError, loadCorpus, loadFixture, sha256 } from '../src/fixtures.js'
import type { Manifest, ResolvedFixture } from '../src/types.js'

let corpus: ResolvedFixture[]
const temps: string[] = []

afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function copyCorpus(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'observer-corpus-'))
  temps.push(dir)
  const dest = path.join(dir, 'fixtures', 'corpus')
  cpSync(path.join(process.cwd(), '..', '..', 'fixtures', 'corpus'), dest, { recursive: true })
  return dest
}

describe('corpus loading', () => {
  it('loads every fixture with all integrity hashes verified (incl. the generated >5 MB body)', async () => {
    corpus = await loadCorpus()
    expect(corpus.length).toBeGreaterThanOrEqual(20)
    for (const fx of corpus) {
      expect(fx.request.headBytes.length).toBeGreaterThan(0)
      expect(fx.response.payloads.length).toBe(fx.response.script.writes.length)
    }
  }, 120_000)

  it('the >5 MB fixture really is >5 MB after generation', async () => {
    const fx = (corpus ?? (await loadCorpus())).find((f) => f.tags.includes('req:body-over-5mb'))
    expect(fx).toBeDefined()
    expect(fx!.request.body.byteLength).toBeGreaterThan(5 * 1024 * 1024)
  }, 120_000)

  it('rejects a tampered payload file with a sha256-naming error (integrity control fires)', async () => {
    const dest = copyCorpus()
    // req-40-tools-nonstream is file-backed (48 KB body > the builder's inline limit)
    const victim = path.join(dest, 'req-40-tools-nonstream', 'request.bin')
    const buf = readFileSync(victim)
    buf[100] = buf[100] === 0x61 ? 0x62 : 0x61 // flip one byte
    writeFileSync(victim, buf)
    const manifest = JSON.parse(readFileSync(path.join(dest, 'manifest.json'), 'utf8')) as Manifest
    const entry = manifest.fixtures.find((f) => f.id === 'req-40-tools-nonstream')!
    await expect(loadFixture(dest, entry)).rejects.toBeInstanceOf(FixtureIntegrityError)
    await expect(loadFixture(dest, entry)).rejects.toThrow(/sha256/)
  })

  it('rejects a tampered manifest (file length change)', async () => {
    const dest = copyCorpus()
    const manifestPath = path.join(dest, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const entry = manifest.fixtures.find((f) => f.id === 'res-429-json')!
    entry.files['fixture.json']!.bytes += 1
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await expect(loadFixture(dest, entry)).rejects.toThrow(/fixture\.json does not match/)
  })
})

describe('acceptance-criterion coverage (task-1: >=20 fixtures, required categories)', () => {
  const REQUIRED_TAGS = [
    'req:40-tools', // a 40-tool request
    'res:stream-reasoning-content', // streaming response carrying reasoning_content
    'res:stream-parallel-tools', // streaming response with >=2 parallel tool calls
    'res:nonstream', // a non-streaming response
    'res:4xx-json', // a 4xx with JSON error body
    'res:5xx-nonjson', // a 5xx with NON-JSON body
    'res:stream-obfuscation', // chunks carrying obfuscation
    'req:body-over-5mb', // request body >5 MB
    'res:stream-abort-mid-chunk', // stream aborted mid-chunk
    'res:stream-done', // [DONE]-terminated stream
  ]

  it('has at least 20 fixtures', async () => {
    const c = corpus ?? (await loadCorpus())
    expect(c.length).toBeGreaterThanOrEqual(20)
  }, 120_000)

  for (const tag of REQUIRED_TAGS) {
    it(`covers "${tag}"`, async () => {
      const c = corpus ?? (await loadCorpus())
      const hits = c.filter((f) => f.tags.includes(tag))
      expect(hits.length, `no fixture carries tag ${tag}`).toBeGreaterThan(0)
    }, 120_000)
  }

  it('the 40-tool fixture really carries 40 tool schemas (derived from the real DSH header)', async () => {
    const c = corpus ?? (await loadCorpus())
    const fx = c.find((f) => f.tags.includes('req:40-tools'))!
    const parsed = JSON.parse(fx.request.body.toString('utf8')) as { tools: unknown[] }
    expect(parsed.tools).toHaveLength(40)
    expect(fx.provenance).toBe('derived')
  }, 120_000)

  it('the parallel-tool-call stream interleaves >=2 distinct tool-call indices', async () => {
    const c = corpus ?? (await loadCorpus())
    const fx = c.find((f) => f.tags.includes('res:stream-parallel-tools'))!
    const indices = new Set<number>()
    for (const p of fx.response.payloads) {
      const text = p.toString('utf8')
      if (!text.startsWith('data: {')) continue
      try {
        const o = JSON.parse(text.slice('data: '.length, text.indexOf('\n\n'))) as {
          choices?: { delta?: { tool_calls?: { index: number }[] } }[]
        }
        for (const tc of o.choices?.[0]?.delta?.tool_calls ?? []) indices.add(tc.index)
      } catch {
        /* [DONE] and friends */
      }
    }
    expect(indices.size).toBeGreaterThanOrEqual(2)
  }, 120_000)

  it('the retry pair carries byte-identical request bodies (V5 request de-dup golden pair)', async () => {
    const c = corpus ?? (await loadCorpus())
    const a = c.find((f) => f.id === 'res-stream-retry-partial')!
    const b = c.find((f) => f.id === 'res-stream-retry-complete')!
    expect(sha256(a.request.body)).toBe(sha256(b.request.body))
    // ...and the partial one really is partial while the complete one terminates with [DONE]
    expect(a.response.script.terminate).toMatchObject({ kind: 'destroy-after-write' })
    const donePayload = b.response.payloads.at(-1)!.toString('utf8')
    expect(donePayload).toBe('data: [DONE]\n\n')
  }, 120_000)

  it('every fixture declares honest provenance (nothing claims to be captured pre-V0a)', async () => {
    const c = corpus ?? (await loadCorpus())
    for (const fx of c) {
      expect(['synthetic', 'derived', 'generated', 'captured']).toContain(fx.provenance)
      // Until the V0a tap exists there are no captured fixtures; if this ever fails,
      // it should be because V0a landed — a good day, not a regression.
      expect(fx.provenance).not.toBe('captured')
    }
  }, 120_000)
})
