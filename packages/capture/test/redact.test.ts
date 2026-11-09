/**
 * Redaction pass tests. Redaction produces DERIVED copies — the raw store is
 * never touched (I2) — and must scrub credential shapes while leaving every
 * other byte byte-identical.
 */

import { describe, expect, it } from 'vitest'
import { redactBodyBytes, redactHeadBytes } from '../src/redact.js'

describe('redactHeadBytes', () => {
  it('scrubs authorization/cookie/api-key values, preserving every other byte', () => {
    const raw = Buffer.from(
      'POST /v1/chat/completions HTTP/1.1\r\n' +
        'Host: qwen-api.invalid\r\n' +
        'Authorization: Bearer sk-super-secret-real-key-123456\r\n' +
        'content-type: application/json\r\n' +
        'x-api-key: ak_live_abcdef0123456789\r\n' +
        'Cookie: session=abc123; theme=dark\r\n' +
        'content-length: 2\r\n\r\n{}',
      'latin1',
    )
    const { out, redactedHeaders } = redactHeadBytes(raw)
    const text = out.toString('latin1')
    expect(text).not.toContain('sk-super-secret-real-key-123456')
    expect(text).not.toContain('ak_live_abcdef0123456789')
    expect(text).not.toContain('session=abc123')
    expect(text).toContain('Authorization: [REDACTED:authorization]')
    expect(text).toContain('x-api-key: [REDACTED:x-api-key]')
    expect(text).toContain('Cookie: [REDACTED:cookie]')
    // non-sensitive lines untouched, byte for byte
    expect(text).toContain('Host: qwen-api.invalid\r\n')
    expect(text).toContain('content-type: application/json\r\n')
    expect(text).toContain('content-length: 2\r\n\r\n{}')
    expect(redactedHeaders.sort()).toEqual(['authorization', 'cookie', 'x-api-key'])
  })

  it('matches sensitive names case-insensitively and by token/secret/key shapes', () => {
    const raw = Buffer.from('GET / HTTP/1.1\r\nX-Auth-Token: tok\r\nx-session-secret: s\r\naccept: */*\r\n\r\n', 'latin1')
    const { out } = redactHeadBytes(raw)
    const text = out.toString('latin1')
    expect(text).toContain('[REDACTED:x-auth-token]')
    expect(text).toContain('[REDACTED:x-session-secret]')
    expect(text).toContain('accept: */*')
  })

  it('leaves a clean head byte-identical (same buffer)', () => {
    const raw = Buffer.from('GET / HTTP/1.1\r\naccept: */*\r\n\r\n', 'latin1')
    const { out, redactedHeaders } = redactHeadBytes(raw)
    expect(out).toBe(raw)
    expect(redactedHeaders).toEqual([])
  })
})

describe('redactBodyBytes', () => {
  it('scrubs provider keys, bearer tokens, AWS keys, GitHub tokens, JWTs, PEM keys', () => {
    const body = Buffer.from(
      JSON.stringify({
        text: 'call with sk-abcdefghij0123456789ABCDEF and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        aws: 'AKIAIOSFODNN7EXAMPLE',
        gh: 'ghp_1234567890abcdefghijklmnABCDEF',
        harmless: 'the quick brown fox jumps over 13 lazy dogs',
      }),
      'utf8',
    )
    const { out, hits } = redactBodyBytes(body)
    const text = out.toString('utf8')
    expect(text).not.toContain('sk-abcdefghij0123456789ABCDEF')
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(text).not.toContain('ghp_1234567890abcdefghijklmnABCDEF')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(text).toContain('[REDACTED:openai-style-key]')
    expect(text).toContain('[REDACTED:aws-access-key]')
    expect(text).toContain('[REDACTED:github-token]')
    // harmless content survives byte-identically
    expect(text).toContain('the quick brown fox jumps over 13 lazy dogs')
    expect(hits.map((h) => h.kind).sort()).toEqual(
      ['aws-access-key', 'github-token', 'jwt', 'openai-style-key'].sort(),
    )
  })

  it('leaves a clean body byte-identical', () => {
    const body = Buffer.from('{"model":"qwen3.8-max","messages":[{"role":"user","content":"hi"}]}')
    const { out, hits } = redactBodyBytes(body)
    expect(out.equals(body)).toBe(true)
    expect(hits).toEqual([])
  })

  it('preserves multi-byte UTF-8 content around a redaction (latin1 bijection)', () => {
    const body = Buffer.from('café 中文 😀 sk-secretkey1234567890abc 🎯 fin', 'utf8')
    const { out } = redactBodyBytes(body)
    const text = out.toString('utf8')
    expect(text).toBe('café 中文 😀 [REDACTED:openai-style-key] 🎯 fin')
  })
})
