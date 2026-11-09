/**
 * Capture replay: serve a recorded response verbatim from a capture directory.
 *
 * Purpose: (1) the sha256-stable capture→replay→re-capture round trip that V0a's
 * acceptance requires, (2) later, driving the rig's mock upstream from real
 * captured traffic. The replay server writes the recorded wire bytes EXACTLY —
 * including original chunk framing and content-encoding — because response.wire.bin
 * is raw truth, not a parsed representation.
 */

import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { findHead, headValue } from './http-lite.js'
import type { CaptureMeta } from './types.js'

export interface ReplayHandle {
  port: number
  origin: string
  stop(): Promise<void>
}

export interface ReplayOptions {
  /**
   * Reproduce recorded inter-arrival timing (deadline-corrected from
   * meta.response.arrivals). Default false: write wire bytes as fast as possible.
   */
  timing?: boolean
}

export async function startReplayServer(captureDir: string, opts: ReplayOptions = {}): Promise<ReplayHandle> {
  const meta = JSON.parse(await readFile(path.join(captureDir, 'meta.json'), 'utf8')) as CaptureMeta
  const wire = await readFile(path.join(captureDir, 'response.wire.bin'))
  const truncated = meta.response.truncated || meta.status !== 'complete'
  const sockets = new Set<net.Socket>()

  const server = net.createServer((client) => {
    sockets.add(client)
    client.setNoDelay(true)
    client.on('error', () => undefined)
    client.on('close', () => sockets.delete(client))

    let pending: Buffer = Buffer.alloc(0)
    let requestConsumed = 0
    let contentLength = 0
    let headDone = false

    const respond = (): void => {
      void (async () => {
        try {
          if (opts.timing && meta.response.arrivals.length > 1) {
            const t0 = performance.now()
            let sent = 0
            for (let i = 0; i < meta.response.arrivals.length; i++) {
              const a = meta.response.arrivals[i]!
              const target = t0 + a.tMs
              const wait = target - performance.now()
              if (wait > 0) await new Promise((r) => setTimeout(r, wait))
              client.write(wire.subarray(sent, a.cumBytes))
              sent = a.cumBytes
            }
            if (sent < wire.length) client.write(wire.subarray(sent))
          } else if (wire.length > 0) {
            client.write(wire)
          }
          if (truncated) client.destroySoon()
          else client.end()
        } catch {
          client.destroy()
        }
      })()
    }

    client.on('data', (d: Buffer) => {
      pending = pending.length === 0 ? d : Buffer.concat([pending, d])
      if (!headDone) {
        const parsed = findHead(pending)
        if (!parsed) return
        headDone = true
        const cl = headValue(parsed, pending.subarray(0, parsed.length), 'content-length')
        contentLength = cl !== undefined ? Number(cl) : 0
        requestConsumed = pending.length - parsed.length
        pending = pending.subarray(parsed.length)
        if (requestConsumed >= contentLength) {
          respond()
          return
        }
      }
      requestConsumed += d.length
      if (requestConsumed >= contentLength) respond()
    })
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
    stop: async () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
