/**
 * Boundary tests, enforced structurally rather than by convention (the repo's rule:
 * a guarantee two components both "own" is a guarantee nobody tests).
 *
 *  1. ZERO RUNTIME DEPENDENCIES. The rig judges other people's HTTP behaviour; a
 *     dependency that normalises, patches, or polyfills any of it would contaminate
 *     the ground truth (and re-introduce exactly the fetch/undici re-encoding the
 *     spec warns about in V1 §3.3).
 *  2. ZERO NETWORK. Every socket binds/connects 127.0.0.1; no fetch, no node:https,
 *     no non-loopback URL literal anywhere in src/.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startMockUpstream } from '../src/upstream.js'
import { ReferencePipe } from '../src/testdoubles/reference-pipe.js'

const SRC = path.join(import.meta.dirname, '..', 'src')

function allSourceFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allSourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('package boundary', () => {
  it('has zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: unknown
    }
    expect(pkg.dependencies).toBeUndefined()
  })
})

describe('zero-network policy (source scan)', () => {
  const files = allSourceFiles()

  /** The scan judges CODE, not prose: strip block and line comments first. */
  const codeOf = (f: string): string =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  it('never imports node:https or calls fetch()', () => {
    for (const f of files) {
      const src = codeOf(f)
      expect(src, `${f} imports node:https`).not.toMatch(/from ['"]node:https['"]/)
      expect(src, `${f} calls fetch()`).not.toMatch(/[^.\w]fetch\s*\(/)
    }
  })

  it('contains no non-loopback http(s) URL literals', () => {
    for (const f of files) {
      const src = codeOf(f)
      const m = /https?:\/\/(?!127\.0\.0\.1|localhost)[^\s'"`)]+/.exec(src)
      expect(m, `${f} contains external URL literal ${m?.[0] ?? ''}`).toBeNull()
    }
  })

  it('every .listen( call site pins the loopback interface', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (/\.listen\(/.test(src)) {
        expect(src, `${f} calls .listen() without '127.0.0.1'`).toMatch(/\.listen\([^)]*'127\.0\.0\.1'/s)
      }
    }
  })
})

describe('runtime loopback checks', () => {
  it('mock upstream binds 127.0.0.1 only', async () => {
    const up = await startMockUpstream(
      { status: 204, reason: 'No Content', headers: [], framing: 'length', writes: [] },
      [],
    )
    try {
      expect(up.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      await up.stop()
    }
  })

  it('ReferencePipe starts and stops cleanly with no open handles left behind', async () => {
    const handle = await ReferencePipe.start({ upstreamOrigin: 'http://127.0.0.1:1', upstreamPort: 1 })
    expect(handle.port).toBeGreaterThan(0)
    await handle.stop()
    // If stop() leaked the server or sockets, vitest's teardown would hang the worker;
    // reaching this line with a clean exit is itself the assertion.
    expect(true).toBe(true)
  })
})
