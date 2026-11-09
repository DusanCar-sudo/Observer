/**
 * Tap round-trip tests — the V0a acceptance criteria, executed:
 *  - recorded bytes are RAW: request head/body byte-identical to what the client
 *    sent; response wire decodes to exactly the upstream's body bytes;
 *  - sha256-STABLE across a capture → replay → re-capture round trip;
 *  - gzip stored as received (never decompressed on the wire path);
 *  - truncation and aborts recorded honestly (incomplete:*, never complete);
 *  - reasoning_content present in the stored bytes (the §4A.1 typed-tap trap);
 *  - keep-alive: multiple sequential requests on one connection each captured;
 *  - concurrent captures do not interleave;
 *  - Host rewrite (production mode) touches EXACTLY the Host value bytes.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadCorpus, ResponseDecoder, runClient, serializeHead, sha256, startMockUpstream } from '@observer/rig'
import type { ResolvedFixture } from '@observer/rig'
import { startReplayServer } from '../src/replay.js'
import { startTap } from '../src/tap.js'
import type { CaptureMeta } from '../src/types.js'

const temps: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

let corpus: ResolvedFixture[] = []
async function fx(id: string): Promise<ResolvedFixture> {
  if (corpus.length === 0) corpus = await loadCorpus()
  const f = corpus.find((x) => x.id === id)
  if (!f) throw new Error(`fixture ${id} missing`)
  return f
}

interface TapRunResult {
  client: Awaited<ReturnType<typeof runClient>>
  captureDir: string
  meta: CaptureMeta
  upstreamCaptureSha: string
}

async function runViaTap(
  fixture: ResolvedFixture,
  opts: { rewriteHost?: boolean; abortAfterMs?: number } = {},
): Promise<TapRunResult> {
  const outDir = tempDir('observer-tap-')
  const up = await startMockUpstream(fixture.response.script, fixture.response.payloads)
  const tap = await startTap({
    upstreamOrigin: up.origin,
    outDir,
    listenPort: 0,
    rewriteHost: opts.rewriteHost ?? false,
  })
  try {
    const client = await runClient({
      port: tap.port,
      headBytes: fixture.request.headBytes,
      body: fixture.request.body,
      timeoutMs: 30_000,
      ...(opts.abortAfterMs !== undefined ? { abortAfterMs: opts.abortAfterMs } : {}),
    })
    const ids = tap.captureIds()
    expect(ids.length).toBeGreaterThanOrEqual(1)
    const captureDir = path.join(outDir, ids[ids.length - 1]!)
    const meta = await waitMeta(captureDir)
    return { client, captureDir, meta, upstreamCaptureSha: up.captures[0]?.bodySha256 ?? '' }
  } finally {
    await tap.stop()
    await up.stop()
  }
}

/** Decode a recorded response.wire.bin with the rig's independent decoder. */
function decodeWire(wire: Buffer): { body: Buffer; complete: boolean } {
  const d = new ResponseDecoder()
  const body = d.feed(wire)
  d.socketEnded()
  return { body, complete: d.outcome === 'complete' }
}

/**
 * Capture finalization is write-behind by design (recording must never sit on the
 * traffic critical path — I1): meta.json lands asynchronously after the exchange
 * ends. Tests WAIT for the record (bounded) instead of racing it.
 */
async function waitMeta(captureDir: string, timeoutMs = 10_000): Promise<CaptureMeta> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  for (;;) {
    try {
      return JSON.parse(readFileSync(path.join(captureDir, 'meta.json'), 'utf8')) as CaptureMeta
    } catch (err) {
      lastErr = err
      if (Date.now() > deadline) {
        throw new Error(`meta.json not finalized within ${timeoutMs}ms in ${captureDir}: ${String(lastErr)}`)
      }
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

/** Same write-behind story for the index: appended AFTER meta.json is renamed. */
async function waitIndexLines(outDir: string, n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const lines = readFileSync(path.join(outDir, 'captures.jsonl'), 'utf8').split('\n').filter(Boolean)
      if (lines.length >= n) return
    } catch {
      /* not created yet */
    }
    if (Date.now() > deadline) throw new Error(`captures.jsonl did not reach ${n} lines within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('raw-byte capture fidelity', () => {
  it('records the request head and body BYTE-IDENTICALLY (reasoning stream)', async () => {
    const fixture = await fx('res-stream-reasoning')
    const r = await runViaTap(fixture)
    expect(r.meta.status).toBe('complete')
    const head = readFileSync(path.join(r.captureDir, 'request.head.bin'))
    expect(head.equals(fixture.request.headBytes), 'request head must be byte-identical').toBe(true)
    const body = readFileSync(path.join(r.captureDir, 'request.body.bin'))
    expect(body.equals(fixture.request.body), 'request body must be byte-identical').toBe(true)
    expect(r.meta.request.bodySha256).toBe(sha256(fixture.request.body))
    // what the upstream saw == what the client sent (zero mutation end to end)
    expect(r.upstreamCaptureSha).toBe(sha256(fixture.request.body))
    // no host rewrite in this mode: no forwarded-head artifact exists
    expect(existsSync(path.join(r.captureDir, 'request.forwarded-head.bin'))).toBe(false)
    expect(r.meta.request.hostRewritten).toBe(false)
  }, 60_000)

  it('records the response wire raw: decodes to exactly the scripted body, reasoning_content INTACT', async () => {
    const fixture = await fx('res-stream-reasoning')
    const r = await runViaTap(fixture)
    const wire = readFileSync(path.join(r.captureDir, 'response.wire.bin'))
    expect(sha256(wire)).toBe(r.meta.response.wireSha256)
    const decoded = decodeWire(wire)
    expect(decoded.complete).toBe(true)
    // the concatenation of scripted payloads IS the expected body — no parse in between
    const expected = Buffer.concat(fixture.response.payloads)
    expect(decoded.body.equals(expected)).toBe(true)
    // the §4A.1 trap: a typed tap would have dropped these; raw bytes keep them
    expect(wire.toString('utf8')).toContain('reasoning_content')
    // and the client saw the same body bytes through the tap
    expect(r.client.bodySha256).toBe(sha256(expected))
  }, 60_000)

  it('stores gzip responses COMPRESSED as received (never decompressed on the wire path)', async () => {
    const fixture = await fx('res-gzip-nonstream')
    const r = await runViaTap(fixture)
    expect(r.meta.status).toBe('complete')
    const wire = readFileSync(path.join(r.captureDir, 'response.wire.bin'))
    expect(wire.toString('latin1')).toContain('content-encoding: gzip')
    const decoded = decodeWire(wire)
    const gzPayload = fixture.response.payloads[0]!
    expect(decoded.body.equals(gzPayload), 'stored body must be the original compressed bytes').toBe(true)
    // sanity: it really is gzip (magic bytes), untouched
    expect(decoded.body[0]).toBe(0x1f)
    expect(decoded.body[1]).toBe(0x8b)
  }, 60_000)

  it('stores brotli responses COMPRESSED as received (task-2 criterion names gzip AND br)', async () => {
    const fixture = await fx('res-br-nonstream')
    const r = await runViaTap(fixture)
    expect(r.meta.status).toBe('complete')
    const wire = readFileSync(path.join(r.captureDir, 'response.wire.bin'))
    expect(wire.toString('latin1')).toContain('content-encoding: br')
    const decoded = decodeWire(wire)
    const brPayload = fixture.response.payloads[0]!
    expect(decoded.body.equals(brPayload), 'stored body must be the original compressed bytes').toBe(true)
  }, 60_000)

  it('client sees byte-identical response through the tap (differential vs scripted payloads)', async () => {
    const fixture = await fx('res-stream-parallel-tools')
    const r = await runViaTap(fixture)
    const expected = Buffer.concat(fixture.response.payloads)
    expect(r.client.framingComplete).toBe(true)
    expect(r.client.body.equals(expected)).toBe(true)
  }, 60_000)
})

describe('truncation and abort honesty', () => {
  it('mid-chunk upstream death: incomplete:upstream-aborted, truncated wire, client truncation matches', async () => {
    const fixture = await fx('res-abort-mid-chunk')
    const r = await runViaTap(fixture)
    expect(r.meta.status).toBe('incomplete:upstream-aborted')
    expect(r.meta.response.truncated).toBe(true)
    const wire = readFileSync(path.join(r.captureDir, 'response.wire.bin'))
    const decoded = decodeWire(wire)
    expect(decoded.complete).toBe(false)
    const terminate = fixture.response.script.terminate as { kind: 'destroy-after-body-bytes'; bodyBytes: number }
    expect(decoded.body.length).toBe(terminate.bodyBytes)
    // the client through the tap saw exactly the same truncated byte count
    expect(r.client.framingComplete).toBe(false)
    expect(r.client.truncatedAtBodyByte).toBe(terminate.bodyBytes)
  }, 60_000)

  it('interrupted-before-DONE stream: recorded incomplete, no fabricated terminator', async () => {
    const fixture = await fx('res-stream-interrupted-no-done')
    const r = await runViaTap(fixture)
    expect(r.meta.status).toBe('incomplete:upstream-aborted')
    const wire = readFileSync(path.join(r.captureDir, 'response.wire.bin'))
    expect(wire.toString('utf8')).not.toContain('[DONE]')
    expect(wire.toString('utf8')).not.toContain('0\r\n\r\n') // no invented chunk terminator
  }, 60_000)

  it('client abort mid-stream: incomplete:client-aborted, upstream released, nothing hangs', async () => {
    const fixture = await fx('res-stream-50ms-timing')
    const r = await runViaTap(fixture, { abortAfterMs: 120 })
    expect(r.client.aborted).toBe(true)
    expect(r.meta.status).toBe('incomplete:client-aborted')
    expect(r.meta.response.truncated).toBe(true)
  }, 60_000)
})

describe('capture/replay round trip — sha256 stability (V0a acceptance)', () => {
  it('capture → replay → re-capture: response wire sha256 identical both times', async () => {
    const fixture = await fx('res-stream-reasoning')
    const first = await runViaTap(fixture)
    expect(first.meta.status).toBe('complete')

    // Replay the recorded capture verbatim, with a SECOND tap capturing in front of it.
    const replay = await startReplayServer(first.captureDir)
    const outDir2 = tempDir('observer-tap2-')
    const tap2 = await startTap({ upstreamOrigin: replay.origin, outDir: outDir2, listenPort: 0, rewriteHost: false })
    try {
      const client2 = await runClient({
        port: tap2.port,
        headBytes: fixture.request.headBytes,
        body: fixture.request.body,
        timeoutMs: 30_000,
      })
      expect(client2.framingComplete).toBe(true)
      const ids = tap2.captureIds()
      const meta2 = await waitMeta(path.join(outDir2, ids[ids.length - 1]!))
      expect(meta2.status).toBe('complete')
      // THE acceptance criterion: sha256-stable across a capture/replay round trip
      expect(meta2.response.wireSha256).toBe(first.meta.response.wireSha256)
      expect(meta2.request.bodySha256).toBe(first.meta.request.bodySha256)
      // and the client-visible body is stable too
      expect(client2.bodySha256).toBe(first.client.bodySha256)
    } finally {
      await tap2.stop()
      await replay.stop()
    }
  }, 60_000)
})

describe('host rewrite (production mode)', () => {
  it('splices EXACTLY the Host value: one replace region, body untouched, both heads recorded', async () => {
    const fixture = await fx('res-nonstream-json')
    const r = await runViaTap(fixture, { rewriteHost: true })
    expect(r.meta.request.hostRewritten).toBe(true)
    const received = readFileSync(path.join(r.captureDir, 'request.head.bin'))
    const forwarded = readFileSync(path.join(r.captureDir, 'request.forwarded-head.bin'))
    expect(received.equals(fixture.request.headBytes)).toBe(true)
    const fwdText = forwarded.toString('latin1')
    // fixture sends lowercase 'host:' — the splice must preserve the original casing
    expect(fwdText.toLowerCase()).toContain('host: 127.0.0.1:')
    expect(fwdText).not.toContain('qwen-api.invalid')
    // everything except the host value is byte-identical: strip both host values and compare
    const norm = (s: string): string => s.replace(/Host: [^\r]+\r/i, 'Host: X\r')
    expect(norm(fwdText)).toBe(norm(received.toString('latin1')))
    // body still zero-mutation even in rewrite mode
    expect(r.upstreamCaptureSha).toBe(sha256(fixture.request.body))
  }, 60_000)
})

describe('keep-alive and concurrency', () => {
  it('two sequential requests on ONE connection are captured separately', async () => {
    const fixture = await fx('res-nonstream-json')
    const outDir = tempDir('observer-tap-ka-')
    const up = await startMockUpstream(fixture.response.script, fixture.response.payloads)
    const tap = await startTap({ upstreamOrigin: up.origin, outDir, listenPort: 0, rewriteHost: false })
    try {
      const results = await new Promise<string[]>((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port: tap.port }, () => {
          sock.setNoDelay(true)
          send(1)
        })
        sock.on('error', reject)
        const bodies: string[] = []
        let decoder = new ResponseDecoder()

        function send(n: number): void {
          const body = Buffer.from(`{"n":${n}}`)
          const head = serializeHead(`POST /req${n} HTTP/1.1`, [
            ['host', 'ka-test.invalid'],
            ['content-type', 'application/json'],
            ['content-length', String(body.length)],
          ])
          sock!.write(Buffer.concat([head, body]))
        }

        sock.on('data', (d: Buffer) => {
          let bytes: Buffer = d
          for (;;) {
            decoder.feed(bytes)
            if (decoder.outcome !== 'complete') return
            bodies.push(`res${bodies.length}:${decoder.head?.statusCode}`)
            // Bytes past this response's framing belong to the NEXT exchange — a
            // coalesced TCP event may carry res1's tail and res2's head together.
            const excess = decoder.drainExcess()
            if (bodies.length === 1) {
              decoder = new ResponseDecoder()
              send(2)
              if (excess.length === 0) return
              bytes = excess
              continue
            }
            sock.end()
            resolve(bodies)
            return
          }
        })
      })
      expect(results).toEqual(['res0:200', 'res1:200'])
      // both exchanges finalized as complete captures
      const metas = []
      for (const id of tap.captureIds()) {
        metas.push(await waitMeta(path.join(outDir, id)))
      }
      expect(metas).toHaveLength(2)
      expect(metas.every((m) => m.status === 'complete')).toBe(true)
      expect(metas[0]!.request.target).toBe('/req1')
      expect(metas[1]!.request.target).toBe('/req2')
    } finally {
      await tap.stop()
      await up.stop()
    }
  }, 60_000)

  it('concurrent captures on one tap do not interleave', async () => {
    const fA = await fx('res-stream-reasoning')
    const fB = await fx('res-nonstream-json')
    const outDir = tempDir('observer-tap-conc-')
    const upA = await startMockUpstream(fA.response.script, fA.response.payloads)
    // Two taps (one per upstream) sharing ONE outDir exercises recorder isolation.
    const tapA = await startTap({ upstreamOrigin: upA.origin, outDir, listenPort: 0, rewriteHost: false })
    const upB = await startMockUpstream(fB.response.script, fB.response.payloads)
    const tapB = await startTap({ upstreamOrigin: upB.origin, outDir, listenPort: 0, rewriteHost: false })
    try {
      const [cA, cB] = await Promise.all([
        runClient({ port: tapA.port, headBytes: fA.request.headBytes, body: fA.request.body, timeoutMs: 30_000 }),
        runClient({ port: tapB.port, headBytes: fB.request.headBytes, body: fB.request.body, timeoutMs: 30_000 }),
      ])
      expect(cA.bodySha256).toBe(sha256(Buffer.concat(fA.response.payloads)))
      expect(cB.bodySha256).toBe(sha256(Buffer.concat(fB.response.payloads)))
      // wait for both write-behind finalizations: meta.json lands before the index
      // line is appended, so wait for the INDEX to reach 2 lines, not just the metas
      for (const id of [...tapA.captureIds(), ...tapB.captureIds()]) {
        await waitMeta(path.join(outDir, id))
      }
      await waitIndexLines(outDir, 2)
      const index = readFileSync(path.join(outDir, 'captures.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { captureId: string; status: string })
      expect(index).toHaveLength(2)
      expect(index.every((e) => e.status === 'complete')).toBe(true)
      expect(index[0]!.captureId).not.toBe(index[1]!.captureId)
    } finally {
      await tapA.stop()
      await tapB.stop()
      await upA.stop()
      await upB.stop()
    }
  }, 60_000)
})
