/**
 * Generator determinism tests. The >5 MB fixture never lives in git; its bytes are
 * re-derived everywhere (local, CI, other architectures) and pinned by sha256 in the
 * manifest. These tests prove the generator side of that bargain.
 */

import { describe, expect, it } from 'vitest'
import { bigChatBody, mulberry32 } from '../src/generators.js'
import { sha256 } from '../src/fixtures.js'

describe('mulberry32', () => {
  it('produces a stable, well-known sequence for a fixed seed', () => {
    const rnd = mulberry32(42)
    const first = [rnd(), rnd(), rnd()]
    const rnd2 = mulberry32(42)
    expect([rnd2(), rnd2(), rnd2()]).toEqual(first)
    for (const x of first) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
    // different seeds diverge
    expect(mulberry32(43)()).not.toBe(first[0])
  })
})

describe('bigChatBody', () => {
  const spec = { kind: 'big-chat-body' as const, seed: 42, targetBytes: 5 * 1024 * 1024 }

  it('is deterministic: two runs produce byte-identical output', () => {
    const a = bigChatBody(spec)
    const b = bigChatBody(spec)
    expect(sha256(a)).toBe(sha256(b))
    expect(a.equals(b)).toBe(true)
  })

  it('meets the size contract (>5 MB acceptance criterion)', () => {
    const buf = bigChatBody(spec)
    expect(buf.byteLength).toBeGreaterThanOrEqual(spec.targetBytes)
    expect(buf.byteLength).toBeLessThan(spec.targetBytes + 512 * 1024) // overshoot stays bounded
  })

  it('produces VALID JSON with the shape the normaliser will need (parse here is test-side only)', () => {
    const buf = bigChatBody({ kind: 'big-chat-body', seed: 7, targetBytes: 64 * 1024 })
    const parsed = JSON.parse(buf.toString('utf8')) as {
      model: string
      messages: { role: string; content?: unknown; tool_calls?: unknown[]; reasoning_content?: string }[]
    }
    expect(parsed.model).toBe('qwen3.8-max')
    expect(parsed.messages.length).toBeGreaterThan(10)
    expect(parsed.messages[0]).toMatchObject({ role: 'system' })
    // exercises shapes V3 must normalise: assistant tool_calls, reasoning_content, tool results
    expect(parsed.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true)
    expect(parsed.messages.some((m) => m.role === 'assistant' && typeof m.reasoning_content === 'string')).toBe(true)
    expect(parsed.messages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('varies with the seed (so multi-seed corpora are not accidental clones)', () => {
    const a = bigChatBody({ kind: 'big-chat-body', seed: 1, targetBytes: 32 * 1024 })
    const b = bigChatBody({ kind: 'big-chat-body', seed: 2, targetBytes: 32 * 1024 })
    expect(a.equals(b)).toBe(false)
  })
})
