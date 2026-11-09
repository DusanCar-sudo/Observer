/**
 * End-to-end test of the capture → fixture export pipeline, run against
 * SYNTHETIC captures produced by the tap itself (the live DSH run is pending a
 * Human-side config change; this proves the machinery before real bytes exist).
 *
 * Pipeline under test:
 *   rig fixture → client → tap → mock upstream   (produces a real capture dir)
 *   tools/captures-to-fixtures.mjs               (capture → fixtures/captured-style corpus)
 *   rig loadCorpus(outDir)                       (integrity + structural validation)
 *   rig runFidelityCheck(ReferencePipe)          (converted fixture replays faithfully)
 *
 * If a converted fixture failed the rig, the export would be laundering captures
 * into broken fixtures — the exact "wrong in a way no test would catch" failure
 * the raw-bytes discipline exists to prevent.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  loadCorpus,
  runClient,
  runFidelityCheck,
  formatReport,
  ReferencePipe,
  startMockUpstream,
} from '@observer/rig'
import type { ResolvedFixture } from '@observer/rig'
import { startTap } from '../src/tap.js'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const temps: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

const CONVERT_IDS = [
  'res-stream-reasoning', // SSE, reasoning_content, [DONE]
  'res-nonstream-json', // content-length framing
  'res-abort-mid-chunk', // truncation → destroy-after-body-bytes fixture
  'res-429-json', // 4xx passthrough
]

async function produceCaptures(): Promise<string> {
  const capturesDir = tempDir('observer-captures-e2e-')
  const corpus = await loadCorpus()

  // One tap per fixture (each needs its own upstream); all share one captures dir,
  // which also exercises recorder isolation across instances.
  for (const id of CONVERT_IDS) {
    const fx = corpus.find((f) => f.id === id)
    if (!fx) throw new Error(`fixture ${id} missing`)
    const up = await startMockUpstream(fx.response.script, fx.response.payloads)
    const t = await startTap({ upstreamOrigin: up.origin, outDir: capturesDir, listenPort: 0, rewriteHost: false })
    try {
      await runClient({ port: t.port, headBytes: fx.request.headBytes, body: fx.request.body, timeoutMs: 30_000 })
      // finalize is write-behind: wait for meta.json
      const deadline = Date.now() + 10_000
      for (;;) {
        const done = t
          .captureIds()
          .every((cid) => existsSync(path.join(capturesDir, cid, 'meta.json')))
        if (done) break
        if (Date.now() > deadline) throw new Error(`capture for ${id} did not finalize`)
        await new Promise((r) => setTimeout(r, 20))
      }
    } finally {
      await t.stop()
      await up.stop()
    }
  }
  return capturesDir
}

describe('captures → fixtures export pipeline', () => {
  it(
    'converts real tap captures into rig-loadable fixtures that pass the ReferencePipe conformance',
    async () => {
      const capturesDir = await produceCaptures()
      const outDir = tempDir('observer-captured-fixtures-')

      execFileSync(
        process.execPath,
        [path.join(repoRoot, 'tools', 'captures-to-fixtures.mjs'), '--captures', capturesDir, '--out', outDir],
        { stdio: 'pipe' },
      )

      expect(existsSync(path.join(outDir, 'manifest.json'))).toBe(true)
      const converted = await loadCorpus(outDir)
      expect(converted.length).toBe(CONVERT_IDS.length)
      for (const fx of converted) {
        expect(fx.provenance).toBe('captured')
        expect(fx.tags).toContain('captured')
        expect(fx.notes).toContain('REDACTED copy')
        // The converted fixture must itself be replayable byte-faithfully —
        // this is the anti-laundering guard.
        const report = await runFidelityCheck({ fixture: fx, sut: ReferencePipe })
        if (report.diffs.length > 0) {
          throw new Error(`converted fixture ${fx.id} fails the rig:\n${formatReport(report, { timelines: true })}`)
        }
      }
      // The reasoning capture must still carry reasoning_content through conversion
      const reasoningFx = converted.find((f) => f.tags.includes('res:stream-reasoning-content'))
      expect(reasoningFx, 'reasoning fixture lost its tag through conversion').toBeDefined()
      const body = Buffer.concat(reasoningFx!.response.payloads).toString('utf8')
      expect(body).toContain('reasoning_content')
      // The truncated capture became a truncation fixture with the right tag
      const abortFx = converted.find((f) => f.tags.includes('res:stream-abort-mid-chunk'))
      expect(abortFx).toBeDefined()
      expect(abortFx!.response.script.terminate?.kind).toBe('destroy-after-body-bytes')
      // The 4xx capture kept its status and JSON tag
      const errFx = converted.find((f) => f.tags.includes('res:4xx-json'))
      expect(errFx).toBeDefined()
      expect(errFx!.response.script.status).toBe(429)
      // redaction ran: the fixture request carried a Bearer key; nothing raw survives
      for (const fx of converted) {
        const requestBin = readFileSync(path.join(fx.dir, 'request.bin')).toString('utf8')
        expect(requestBin).not.toContain('sk-observer-fixture')
        const fxText = readFileSync(path.join(fx.dir, 'fixture.json'), 'utf8')
        expect(fxText).not.toContain('sk-observer-fixture')
        const fxJson = JSON.parse(fxText) as { request: { headers: [string, string][] } }
        const auth = fxJson.request.headers.find(([n]) => n.toLowerCase() === 'authorization')
        if (auth) expect(auth[1]).toMatch(/^\[REDACTED:authorization\]$/)
      }
    },
    240_000,
  )
})
