/**
 * §9.4 NAMED TEST — the keep-alive finalise race.
 *
 * The shape (found by a tap test, promoted to a constraint by lead): capture
 * finalisation is WRITE-BEHIND (it must never sit on the traffic path), so there
 * is a window where the previous exchange's response is fully delivered but its
 * recorder is still flushing. Bytes of the NEXT keep-alive request arriving in
 * that window must be REQUEUED for the next exchange — never misclassified as
 * pipelining (which kills the connection) and never dropped.
 *
 * This class of race recurs anywhere streaming and capturing meet; if you touch
 * the exchange lifecycle in proxy-core, this test is the tripwire.
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { ResponseDecoder, serializeHead, startMockUpstream } from '@observer/rig'
import { startGateway } from '../src/index.js'
import { fixture, tempDir, waitMeta } from './helpers.js'
import path from 'node:path'

describe('§9.4 keep-alive finalize race', () => {
  it(
    'two sequential requests on ONE connection, the second fired the instant the first response completes: both captured complete, connection survives, zero pipelining refusals',
    async () => {
      const fx = await fixture('res-nonstream-json')
      const outDir = tempDir()
      const up = await startMockUpstream(fx.response.script, fx.response.payloads)
      const gw = await startGateway({
        upstreamOrigin: up.origin,
        rewriteHost: false,
        captureOutDir: outDir,
        listenPort: 0,
      })
      try {
        const results = await new Promise<string[]>((resolve, reject) => {
          const sock = net.connect({ host: '127.0.0.1', port: gw.port }, () => {
            sock.setNoDelay(true)
            send(1)
          })
          sock.on('error', reject)
          const done: string[] = []
          let decoder = new ResponseDecoder()

          function send(n: number): void {
            const body = Buffer.from(`{"n":${n}}`)
            const head = serializeHead(`POST /v1/chat/completions HTTP/1.1`, [
              ['host', 'race-test.invalid'],
              ['content-type', 'application/json'],
              ['content-length', String(body.length)],
              // NOTE: no connection header — keep-alive is the default and the
              // whole point of this test.
            ])
            sock.write(Buffer.concat([head, body]))
          }

          sock.on('data', (d: Buffer) => {
            let bytes: Buffer = d
            for (;;) {
              decoder.feed(bytes)
              if (decoder.outcome !== 'complete') return
              done.push(`res${done.length}:${decoder.head?.statusCode}`)
              const excess = decoder.drainExcess()
              if (done.length === 1) {
                decoder = new ResponseDecoder()
                // Fire the next request IMMEDIATELY — inside the previous
                // exchange's write-behind finalize window. This is the race.
                send(2)
                if (excess.length === 0) return
                bytes = excess
                continue
              }
              sock.end()
              resolve(done)
              return
            }
          })
        })

        expect(results).toEqual(['res0:200', 'res1:200'])

        // Both exchanges finalized as complete captures — the second was NOT
        // misclassified as pipelining and NOT dropped.
        const ids = gw.captureIds()
        expect(ids).toHaveLength(2)
        const metas = []
        for (const id of ids) metas.push(await waitMeta(path.join(outDir, id)))
        expect(metas.every((m) => m.status === 'complete')).toBe(true)

        const stats = gw.stats()
        expect(stats.exchanges).toBe(2)
        expect(stats.forwarded).toBe(2)
        expect(Object.keys(stats.refused)).toEqual([])
        expect(stats.captureErrors).toBe(0)
      } finally {
        await gw.stop()
        await up.stop()
      }
    },
    60_000,
  )
})
