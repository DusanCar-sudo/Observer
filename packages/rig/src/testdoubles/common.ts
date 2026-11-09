/**
 * Proxy test-double factory for rig self-verification.
 *
 * ⚠ NOTHING IN THIS DIRECTORY IS OBSERVER PRODUCTION CODE. ⚠
 * These are test doubles with one job each: the ReferencePipe proves the rig passes
 * a byte-faithful proxy (no false positives), and the faulty doubles in faulty.ts
 * prove the rig DETECTS each mutation class the project is named after (no false
 * negatives). The V1 gateway lives in packages/gateway and must pass this same rig.
 *
 * The factory is deliberately a plain node:http proxy: the doubles model the kind of
 * implementation someone would actually write by accident (SDK-typed parsing,
 * buffering for convenience, header "cleanup"), which is why the sins live here as
 * working code rather than as strawmen.
 */

import http from 'node:http'
import net from 'node:net'
import { isHopByHop, rawHeaderPairs } from '../http.js'
import type { HeaderPairs, Sut, SutHandle } from '../types.js'

export type BodyStrategy =
  | { kind: 'passthrough' }
  /** Sin: hold the entire response, then deliver it in one write. */
  | { kind: 'buffer-all' }
  /** Sin: merge arrivals into fewer, larger writes (timer/size based). */
  | { kind: 'coalesce'; maxBytes: number; idleMs: number }
  /** Sin: re-frame per SSE event, rewriting `data:` payloads through transformEvent. */
  | { kind: 'sse-rewrite'; transformEvent: (parsed: unknown) => unknown }

export interface ProxyHooks {
  name: string
  /** Sin slot: buffer the request body and transform it before forwarding. */
  transformRequest?: (body: Buffer, headers: HeaderPairs) => Buffer
  /** Sin slot: transform the (already hop-filtered) response header pairs. */
  transformResponseHeaders?: (pairs: HeaderPairs) => HeaderPairs
  bodyStrategy?: BodyStrategy
}

function replaceContentLength(pairs: HeaderPairs, bytes: number): HeaderPairs {
  let seen = false
  const out: HeaderPairs = []
  for (const [n, v] of pairs) {
    if (n.toLowerCase() === 'content-length') {
      seen = true
      out.push([n, String(bytes)])
    } else {
      out.push([n, v])
    }
  }
  if (!seen) out.push(['content-length', String(bytes)])
  return out
}

function flat(pairs: HeaderPairs): string[] {
  return pairs.flatMap(([n, v]) => [n, v])
}

export function createProxySut(hooks: ProxyHooks): Sut {
  const strategy = hooks.bodyStrategy ?? { kind: 'passthrough' as const }

  return {
    name: hooks.name,
    async start(ctx: { upstreamOrigin: string; upstreamPort: number }): Promise<SutHandle> {
      const sockets = new Set<net.Socket>()
      const server = http.createServer((creq, cres) => {
        handle(creq, cres, ctx.upstreamPort, hooks, strategy)
      })
      server.on('connection', (s) => {
        s.setNoDelay(true)
        sockets.add(s)
        s.on('close', () => sockets.delete(s))
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
        stop: async () => {
          for (const s of sockets) s.destroy()
          sockets.clear()
          await new Promise<void>((resolve) => server.close(() => resolve()))
        },
      }
    },
  }
}

function handle(
  creq: http.IncomingMessage,
  cres: http.ServerResponse,
  upstreamPort: number,
  hooks: ProxyHooks,
  strategy: BodyStrategy,
): void {
  const inPairs = rawHeaderPairs(creq.rawHeaders)
  const fwdPairs = inPairs.filter(([n]) => !isHopByHop(n))

  let upReq: http.ClientRequest | undefined
  const abortUpstream = (): void => {
    if (upReq && !upReq.destroyed) upReq.destroy()
  }
  // Client abort must propagate upstream (V4d criterion; present from day one so the
  // doubles exercise the same plumbing the gateway will).
  creq.on('close', () => {
    if (!creq.complete) abortUpstream()
  })
  creq.on('error', abortUpstream)

  const send = (pairs: HeaderPairs, body: Buffer | 'stream'): void => {
    upReq = http.request(
      { host: '127.0.0.1', port: upstreamPort, method: creq.method, path: creq.url ?? '/' },
      (upRes) => {
        onUpstreamResponse(upRes, cres, hooks, strategy)
      },
    )
    upReq.on('error', (err: Error) => {
      if (!cres.headersSent) {
        cres.writeHead(502, 'Bad Gateway', ['content-type', 'text/plain', 'connection', 'close'])
        cres.end(`observer rig test double "${hooks.name}": upstream request failed: ${err.message}`)
      } else if (!cres.writableEnded) {
        cres.socket?.destroySoon()
      }
    })
    for (const [n, v] of pairs) upReq.setHeader(n, v)
    if (body === 'stream') {
      creq.pipe(upReq)
    } else {
      upReq.end(body)
    }
  }

  if (hooks.transformRequest) {
    const chunks: Buffer[] = []
    creq.on('data', (c: Buffer) => chunks.push(c))
    creq.on('end', () => {
      const original = Buffer.concat(chunks)
      const transformed = hooks.transformRequest!(original, inPairs)
      send(replaceContentLength(fwdPairs, transformed.length), transformed)
    })
  } else {
    send(fwdPairs, 'stream')
  }
}

function onUpstreamResponse(
  upRes: http.IncomingMessage,
  cres: http.ServerResponse,
  hooks: ProxyHooks,
  strategy: BodyStrategy,
): void {
  const status = upRes.statusCode ?? 502
  const reason = upRes.statusMessage ?? ''
  let outPairs = rawHeaderPairs(upRes.rawHeaders).filter(([n]) => !isHopByHop(n))
  if (hooks.transformResponseHeaders) outPairs = hooks.transformResponseHeaders(outPairs)

  const isSse = (outPairs.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? '').includes('text/event-stream')

  if (strategy.kind === 'buffer-all') {
    const chunks: Buffer[] = []
    upRes.on('data', (c: Buffer) => chunks.push(c))
    upRes.on('end', () => {
      if (cres.writableEnded) return
      cres.writeHead(status, reason, flat(outPairs))
      const body = Buffer.concat(chunks)
      if (body.length > 0) cres.write(body)
      cres.end()
    })
    upRes.on('error', () => cres.socket?.destroySoon())
    upRes.on('close', () => {
      // Truncated upstream + buffering proxy: nothing coherent to deliver; die the way
      // a buffering implementation actually dies — without the client's bytes.
      if (!upRes.complete && !cres.writableEnded) cres.socket?.destroySoon()
    })
    return
  }

  if (strategy.kind === 'sse-rewrite' && isSse) {
    // Drop content-length if present: rewriting changes the byte count, and node will
    // re-frame as chunked. (All SSE fixtures are chunked anyway.)
    outPairs = outPairs.filter(([n]) => n.toLowerCase() !== 'content-length')
    cres.writeHead(status, reason, flat(outPairs))
    let buf: Buffer = Buffer.alloc(0)
    upRes.on('data', (d: Buffer) => {
      buf = buf.length === 0 ? d : Buffer.concat([buf, d])
      for (;;) {
        const idx = buf.indexOf('\n\n')
        if (idx === -1) break
        const rawEvent = buf.subarray(0, idx).toString('utf8') // exclude the blank-line terminator
        buf = buf.subarray(idx + 2)
        cres.write(Buffer.from(rewriteSseEvent(rawEvent, strategy.transformEvent) + '\n\n', 'utf8'))
      }
    })
    upRes.on('end', () => {
      if (buf.length > 0) cres.write(buf) // unterminated tail: pass through raw
      cres.end()
    })
    upRes.on('error', () => cres.socket?.destroySoon())
    upRes.on('close', () => {
      if (!upRes.complete && !cres.writableEnded) cres.socket?.destroySoon()
    })
    return
  }

  if (strategy.kind === 'coalesce') {
    cres.writeHead(status, reason, flat(outPairs))
    let pending: Buffer[] = []
    let pendingBytes = 0
    let timer: NodeJS.Timeout | undefined
    const flush = (): void => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (pendingBytes > 0 && !cres.writableEnded) {
        cres.write(Buffer.concat(pending))
        pending = []
        pendingBytes = 0
      }
    }
    upRes.on('data', (d: Buffer) => {
      pending.push(Buffer.from(d))
      pendingBytes += d.length
      if (pendingBytes >= strategy.maxBytes) {
        flush()
      } else {
        if (timer) clearTimeout(timer)
        timer = setTimeout(flush, strategy.idleMs)
      }
    })
    upRes.on('end', () => {
      flush()
      cres.end()
    })
    upRes.on('error', () => {
      flush()
      cres.socket?.destroySoon()
    })
    upRes.on('close', () => {
      if (!upRes.complete && !cres.writableEnded) {
        flush()
        cres.socket?.destroySoon()
      }
    })
    return
  }

  // passthrough (default): one client write per upstream arrival — boundaries preserved.
  cres.writeHead(status, reason, flat(outPairs))
  upRes.on('data', (d: Buffer) => {
    if (!cres.writableEnded) cres.write(d)
  })
  upRes.on('end', () => {
    if (!cres.writableEnded) cres.end()
  })
  upRes.on('error', () => {
    if (!cres.writableEnded) cres.socket?.destroySoon()
  })
  upRes.on('close', () => {
    if (!upRes.complete && !cres.writableEnded) cres.socket?.destroySoon()
  })
}

function rewriteSseEvent(rawEvent: string, transformEvent: (parsed: unknown) => unknown): string {
  if (rawEvent.startsWith(':')) return rawEvent // SSE comment: pass through
  if (!rawEvent.startsWith('data: ')) return rawEvent // unknown event shapes: pass through
  const payload = rawEvent.slice('data: '.length)
  if (payload.startsWith('[DONE]')) return rawEvent // never JSON-parse [DONE] — even the sinning double guards this
  try {
    const parsed: unknown = JSON.parse(payload)
    return `data: ${JSON.stringify(transformEvent(parsed))}`
  } catch {
    return rawEvent // unparseable data: pass through (this double's sin is field-dropping, not crashing)
  }
}
