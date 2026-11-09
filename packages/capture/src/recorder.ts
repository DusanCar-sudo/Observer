/**
 * Capture recorder: streaming, hash-as-you-go artifact writer.
 *
 * Discipline: the RAW store is append-only truth (I2). Artifacts are written as
 * bytes arrive (no full-body buffering — bodies exceed 10 MB at 1M-token context),
 * sha256 is incremental, and meta.json is written LAST so its presence is the
 * completion marker: a capture dir without meta.json was interrupted and must be
 * treated as suspect, never parsed as valid. Redaction never touches this store —
 * it is applied to derived copies at export time.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from 'node:fs'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CaptureArrival, CaptureIndexEntry, CaptureMeta, CaptureStatus } from './types.js'

export interface RecordingCapture {
  readonly id: string
  readonly dir: string
  recordRequestHead(bytes: Buffer): void
  /** Only when the tap actually spliced something (Host rewrite); raw store keeps both truths. */
  recordForwardedHead(bytes: Buffer): void
  recordRequestBody(chunk: Buffer, tMs: number): void
  recordResponseWire(chunk: Buffer, tMs: number): void
  setRequestLine(method: string, target: string, httpVersion: string): void
  setResponseStatusLine(line: string): void
  setHostRewritten(v: boolean): void
  setUpstream(origin: string, tls: boolean): void
  /** Finalize: flush streams, write meta.json, append index line. Idempotent per capture. */
  finalize(status: CaptureStatus, error?: string): Promise<CaptureMeta>
}

function utcCompact(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export class CaptureRecorder {
  readonly outDir: string
  #counter = 0
  #indexPath: string

  constructor(outDir: string) {
    this.outDir = path.resolve(outDir)
    mkdirSync(this.outDir, { recursive: true })
    this.#indexPath = path.join(this.outDir, 'captures.jsonl')
  }

  begin(startedAt: Date = new Date()): RecordingCapture {
    // Collision-resistant by construction: two recorders sharing an outDir (two
    // taps, or one restarted within the same second) must NEVER produce the same
    // id — an id collision is a silent overwrite, and the raw store is append-only
    // truth (I2). Timestamp keeps ids sortable; pid+random separates instances;
    // the counter separates exchanges within one instance; the existence loop is
    // the structural backstop.
    let id: string
    let dir: string
    for (;;) {
      const rand = randomBytes(4).toString('hex')
      id = `cap-${utcCompact(startedAt)}-${process.pid}-${rand}-${String(++this.#counter).padStart(4, '0')}`
      dir = path.join(this.outDir, id)
      if (!existsSync(dir)) break
    }
    mkdirSync(dir, { recursive: true })

    const bodyStream: WriteStream = createWriteStream(path.join(dir, 'request.body.bin'))
    const wireStream: WriteStream = createWriteStream(path.join(dir, 'response.wire.bin'))
    const bodyHash = createHash('sha256')
    const wireHash = createHash('sha256')

    const reqArrivals: CaptureArrival[] = []
    const resArrivals: CaptureArrival[] = []
    let reqBodyBytes = 0
    let resWireBytes = 0
    let reqHeadBytes = 0
    let method = ''
    let target = ''
    let httpVersion = ''
    let statusLine: string | undefined
    let hostRewritten = false
    let upstream = { origin: '', tls: false }
    let finalized: Promise<CaptureMeta> | undefined

    const closeStream = (s: WriteStream): Promise<void> =>
      new Promise((resolve, reject) => {
        s.end(() => resolve())
        s.on('error', reject)
      })

    const indexPath = this.#indexPath

    const rec: RecordingCapture = {
      id,
      dir,
      recordRequestHead(bytes) {
        // Small and synchronous: the head is written whole.
        writeFileSync(path.join(dir, 'request.head.bin'), bytes)
        reqHeadBytes = bytes.length
      },
      recordForwardedHead(bytes) {
        writeFileSync(path.join(dir, 'request.forwarded-head.bin'), bytes)
      },
      recordRequestBody(chunk, tMs) {
        bodyHash.update(chunk)
        reqBodyBytes += chunk.length
        reqArrivals.push({ tMs, bytes: chunk.length, cumBytes: reqBodyBytes })
        bodyStream.write(chunk)
      },
      recordResponseWire(chunk, tMs) {
        wireHash.update(chunk)
        resWireBytes += chunk.length
        resArrivals.push({ tMs, bytes: chunk.length, cumBytes: resWireBytes })
        wireStream.write(chunk)
      },
      setRequestLine(m, t, v) {
        method = m
        target = t
        httpVersion = v
      },
      setResponseStatusLine(line) {
        if (statusLine === undefined) statusLine = line
      },
      setHostRewritten(v) {
        hostRewritten = v
      },
      setUpstream(origin, tls) {
        upstream = { origin, tls }
      },
      finalize(status, error) {
        if (finalized) return finalized
        finalized = (async () => {
          await Promise.all([closeStream(bodyStream), closeStream(wireStream)])
          const meta: CaptureMeta = {
            captureId: id,
            startedAt: startedAt.toISOString(),
            status,
            upstream: { origin: upstream.origin, tls: upstream.tls },
            request: {
              method,
              target,
              httpVersion,
              headBytes: reqHeadBytes,
              bodyBytes: reqBodyBytes,
              bodySha256: bodyHash.digest('hex'),
              hostRewritten,
              arrivals: reqArrivals,
            },
            response: {
              wireBytes: resWireBytes,
              wireSha256: wireHash.digest('hex'),
              ...(statusLine !== undefined ? { statusLine } : {}),
              arrivals: resArrivals,
              truncated: status !== 'complete',
            },
            ...(error !== undefined ? { error } : {}),
            redacted: false,
          }
          await mkdir(dir, { recursive: true })
          // meta.json is the completion marker: written last, atomically (tmp+rename).
          const tmp = path.join(dir, 'meta.json.tmp')
          await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
          await rename(tmp, path.join(dir, 'meta.json'))
          const entry: CaptureIndexEntry = {
            captureId: id,
            startedAt: meta.startedAt,
            status,
            method,
            target,
            ...(statusLine !== undefined ? { responseStatusLine: statusLine } : {}),
            requestBodyBytes: reqBodyBytes,
            responseWireBytes: resWireBytes,
            requestBodySha256: meta.request.bodySha256,
            responseWireSha256: meta.response.wireSha256,
          }
          await appendFile(indexPath, `${JSON.stringify(entry)}\n`, 'utf8')
          return meta
        })()
        return finalized
      },
    }
    return rec
  }
}
