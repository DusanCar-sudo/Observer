/**
 * Scripted mock upstream on a RAW net server.
 *
 * WHY RAW: the upstream is the ground truth of the differential. A framework server
 * would normalise header order/casing, inject its own Date/Connection, and re-frame
 * bodies on its own schedule — every one of those is exactly the kind of mutation the
 * rig exists to detect in a SUT, so the ground-truth side may not contain any of it.
 * Here: the script's bytes go on the wire, one scripted write = one chunked frame =
 * one TCP write (nodelay), with deadline-corrected delays.
 *
 * The upstream also captures the REQUEST exactly as received (raw head bytes, body
 * arrivals, incremental sha256), which is what makes the rig able to verify the V1/A1
 * criterion later: bytes the upstream saw vs bytes the client sent.
 *
 * Loopback-only: binds 127.0.0.1 on an ephemeral port. Zero network.
 */

import { createHash } from 'node:crypto'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import { findHeader, HeadParser, parseRequestLine, SPLIT_GAP_MS } from './http.js'
import type { ArrivalEvent, HeaderPairs, ResponseScript, UpstreamRequestCapture } from './types.js'

export interface MockUpstream {
  port: number
  /** http://127.0.0.1:<port> */
  origin: string
  /** One capture per request received, in arrival order. */
  captures: UpstreamRequestCapture[]
  stop(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((r) => {
    setTimeout(r, ms)
  })
}

function writeAsync(socket: net.Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export async function startMockUpstream(script: ResponseScript, payloads: Buffer[]): Promise<MockUpstream> {
  if (payloads.length !== script.writes.length) {
    throw new Error(`script has ${script.writes.length} writes but ${payloads.length} payloads were resolved`)
  }
  const captures: UpstreamRequestCapture[] = []
  const sockets = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('error', () => {
      /* transport errors are observations, not crashes */
    })
    socket.on('close', () => sockets.delete(socket))
    void handleConnection(socket, script, payloads, captures)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('unexpected listen address')

  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    captures,
    stop: async () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function handleConnection(
  socket: net.Socket,
  script: ResponseScript,
  payloads: Buffer[],
  captures: UpstreamRequestCapture[],
): Promise<void> {
  const connStart = performance.now()
  const parser = new HeadParser()
  const hash = createHash('sha256')
  const bodyPieces: Buffer[] = []
  const bodyEvents: ArrivalEvent[] = []

  const capture: UpstreamRequestCapture = {
    headBytes: Buffer.alloc(0),
    method: '',
    target: '',
    httpVersion: '',
    headerPairs: [],
    bodyEvents,
    body: Buffer.alloc(0),
    bodySha256: '',
    bodyComplete: false,
    clientClosedEarly: false,
    headAtMs: 0,
  }
  captures.push(capture)

  let raw: Buffer = Buffer.alloc(0)
  let declaredContentLength = 0
  let remainingForBody = 0
  let bodyCum = 0
  let headDone = false
  let requestDone = false

  // Resolved true when the full declared body arrived, false if the client vanished
  // first (that is the upstream-side view of a client abort / a SUT cancelling its
  // upstream request — recorded, never answered).
  const completion = new Promise<boolean>((resolveCompletion) => {
    const settle = (v: boolean): void => {
      if (requestDone) return
      requestDone = true
      resolveCompletion(v)
    }

    const consumeBody = (data: Buffer): void => {
      if (remainingForBody <= 0) return
      const tMs = performance.now() - connStart - capture.headAtMs
      const take = Math.min(remainingForBody, data.length)
      const piece = data.subarray(0, take)
      hash.update(piece)
      bodyPieces.push(Buffer.from(piece))
      bodyCum += take
      bodyEvents.push({ tMs, bytes: take, cumBytes: bodyCum })
      remainingForBody -= take
      if (remainingForBody <= 0) {
        capture.bodyComplete = true
        capture.bodyDoneAtMs = performance.now() - connStart
        settle(true)
      }
    }

    socket.on('data', (data: Buffer) => {
      raw = raw.length === 0 ? Buffer.from(data) : Buffer.concat([raw, data])
      if (!headDone) {
        let rest: Buffer
        try {
          rest = parser.feed(data)
        } catch {
          settle(false)
          socket.destroy()
          return
        }
        if (!parser.done) return
        headDone = true
        capture.headAtMs = performance.now() - connStart
        const parsed = parser.result!
        capture.headBytes = Buffer.from(raw.subarray(0, parsed.headByteLength))
        try {
          const line = parseRequestLine(parsed.firstLine)
          capture.method = line.method
          capture.target = line.target
          capture.httpVersion = line.httpVersion
        } catch {
          settle(false)
          socket.destroy()
          return
        }
        capture.headerPairs = parsed.headers
        const te = findHeader(parsed.headers, 'transfer-encoding')
        if (te !== undefined && te.toLowerCase().includes('chunked')) {
          // V0 fixtures never send chunked request bodies; refuse loudly rather than
          // silently mis-capture (the fixture loader validates this too).
          settle(false)
          socket.destroy()
          return
        }
        const cl = findHeader(parsed.headers, 'content-length')
        declaredContentLength = cl !== undefined ? Number(cl) : 0
        if (!Number.isInteger(declaredContentLength) || declaredContentLength < 0) {
          settle(false)
          socket.destroy()
          return
        }
        capture.declaredContentLength = declaredContentLength
        remainingForBody = declaredContentLength
        if (remainingForBody === 0) {
          capture.bodyComplete = true
          capture.bodyDoneAtMs = performance.now() - connStart
          settle(true)
          return
        }
        if (rest.length > 0) consumeBody(rest)
        return
      }
      consumeBody(data)
    })

    socket.once('end', () => {
      if (!capture.bodyComplete) {
        capture.clientClosedEarly = true
        settle(false)
      }
    })
    socket.once('close', () => {
      if (!capture.bodyComplete) capture.clientClosedEarly = true
      settle(false)
    })
  })

  try {
    const ok = await completion
    capture.body = bodyPieces.length === 0 ? Buffer.alloc(0) : Buffer.concat(bodyPieces)
    capture.bodySha256 = hash.digest('hex')
    if (!ok) {
      socket.destroy()
      return
    }

    // ---- emit scripted response ----
    const headPairs: HeaderPairs = [...script.headers]
    const hasTE = script.headers.some(([n]) => n.toLowerCase() === 'transfer-encoding')
    const hasCL = script.headers.some(([n]) => n.toLowerCase() === 'content-length')
    const totalPayloadBytes = payloads.reduce((n, b) => n + b.length, 0)
    if (script.framing === 'chunked' && !hasTE) {
      headPairs.push(['transfer-encoding', 'chunked'])
    } else if (script.framing === 'length' && !hasCL) {
      headPairs.push(['content-length', String(script.contentLength ?? totalPayloadBytes)])
    }
    let headStr = `HTTP/1.1 ${script.status} ${script.reason}\r\n`
    for (const [n, v] of headPairs) headStr += `${n}: ${v}\r\n`
    headStr += '\r\n'
    await writeAsync(socket, Buffer.from(headStr, 'utf8'))

    const terminate = script.terminate ?? { kind: 'end' as const }
    const t0 = performance.now()
    let cumDelay = 0
    let sentBodyBytes = 0
    let terminatedEarly = false

    for (let i = 0; i < script.writes.length; i++) {
      const w = script.writes[i]!
      const payload = payloads[i]!
      cumDelay += w.delayMs
      const wait = t0 + cumDelay - performance.now()
      if (wait > 0) await sleep(wait)

      // destroy-after-body-bytes may cut THIS write short (mid-chunk abort).
      if (terminate.kind === 'destroy-after-body-bytes') {
        const allowed = terminate.bodyBytes - sentBodyBytes
        if (allowed <= 0) {
          socket.destroy()
          terminatedEarly = true
          break
        }
        if (allowed < payload.length) {
          // Deliberately malformed framing: a chunk size line for a payload that never
          // fully arrives (or none at all, in 'length' mode). That is what a real
          // mid-chunk death looks like to a client.
          const part = Buffer.from(payload.subarray(0, allowed))
          const framed =
            script.framing === 'chunked'
              ? Buffer.concat([Buffer.from(`${allowed.toString(16)}\r\n`, 'latin1'), part])
              : part
          await writeAsync(socket, framed)
          socket.destroy()
          terminatedEarly = true
          break
        }
      }

      const splitAt = w.splitAfterBytes
      const canSplit = splitAt !== undefined && splitAt > 0 && splitAt < payload.length
      if (script.framing === 'chunked') {
        const frameHead = Buffer.from(`${payload.length.toString(16)}\r\n`, 'latin1')
        const frameTail = Buffer.from('\r\n', 'latin1')
        if (canSplit) {
          // One chunked frame delivered as TWO TCP writes (mid-frame flush), separated
          // by SPLIT_GAP_MS so the two arrivals stay distinct under load.
          await writeAsync(socket, Buffer.concat([frameHead, payload.subarray(0, splitAt!)]))
          await sleep(SPLIT_GAP_MS)
          await writeAsync(socket, Buffer.concat([payload.subarray(splitAt!), frameTail]))
        } else {
          await writeAsync(socket, Buffer.concat([frameHead, payload, frameTail]))
        }
      } else if (canSplit) {
        await writeAsync(socket, Buffer.from(payload.subarray(0, splitAt!)))
        await sleep(SPLIT_GAP_MS)
        await writeAsync(socket, Buffer.from(payload.subarray(splitAt!)))
      } else {
        await writeAsync(socket, payload)
      }
      sentBodyBytes += payload.length

      if (terminate.kind === 'destroy-after-write' && terminate.writeIndex === i) {
        socket.destroy()
        terminatedEarly = true
        break
      }
    }

    if (!terminatedEarly) {
      if (terminate.kind === 'end') {
        if (script.framing === 'chunked') {
          await writeAsync(socket, Buffer.from('0\r\n\r\n', 'latin1'))
        }
        socket.end()
      } else {
        // A destroy-terminate that never triggered (writeIndex/bodyBytes beyond the
        // script) is a fixture bug — fail loudly rather than ending cleanly.
        throw new Error(`terminate ${JSON.stringify(terminate)} did not trigger; fixture script is inconsistent`)
      }
    }
  } catch {
    socket.destroy()
  }
}
