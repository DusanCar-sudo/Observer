/**
 * Unit tests for the byte/header diff engine — with GOLDEN offsets. These are the
 * tests that prove the rig's reports are precise ("offset 12, 4 bytes deleted"),
 * not vague ("bodies differ").
 */

import { describe, expect, it } from 'vitest'
import { compareHeaderPairs, diffBytes } from '../src/diff.js'

describe('diffBytes', () => {
  it('reports equal buffers with no regions', () => {
    const r = diffBytes(Buffer.from('hello world'), Buffer.from('hello world'))
    expect(r.equal).toBe(true)
    expect(r.regions).toEqual([])
  })

  it('locates a single-byte replace at the exact offset', () => {
    const r = diffBytes(Buffer.from('hello world'), Buffer.from('hello World'))
    expect(r.equal).toBe(false)
    expect(r.regions).toHaveLength(1)
    expect(r.regions[0]).toMatchObject({ offset: 6, op: 'replace', baseline: { len: 1 }, sut: { len: 1 } })
    expect(r.regions[0]!.baseline.hex).toBe('77') // 'w'
    expect(r.regions[0]!.sut.hex).toBe('57') // 'W'
  })

  it('locates a deletion with offset and lengths (the dropped-field shape)', () => {
    const baseline = Buffer.from('data: {"a":1,"obfuscation":"xyz","b":2}')
    const sut = Buffer.from('data: {"a":1,"b":2}')
    const r = diffBytes(baseline, sut)
    expect(r.regions.length).toBeGreaterThanOrEqual(1)
    const region = r.regions[0]!
    expect(region.op).toBe('delete')
    // The opening quote is shared by both sides, so the common prefix ends at 'o'.
    expect(region.offset).toBe(baseline.indexOf('"obfuscation"') + 1)
    expect(region.baseline.ascii).toContain('obfuscation')
    expect(region.sut.len).toBe(0)
  })

  it('locates an insertion at the exact offset', () => {
    const baseline = Buffer.from('{"a":1}')
    const sut = Buffer.from('{"a":1,"x":2}')
    const r = diffBytes(baseline, sut)
    expect(r.regions).toHaveLength(1)
    expect(r.regions[0]).toMatchObject({ op: 'insert', offset: 6, baseline: { len: 0 } })
    expect(r.regions[0]!.sut.ascii).toContain('"x":2')
  })

  it('separates multiple scattered edits into distinct regions via anchor resync', () => {
    const filler = 'x'.repeat(64) // >= ANCHOR_LEN of stable bytes between edits
    const baseline = Buffer.from(`A${filler}B${filler}C${filler}D`)
    const sut = Buffer.from(`a${filler}B${filler}c${filler}D`)
    const r = diffBytes(baseline, sut)
    expect(r.regions).toHaveLength(2)
    expect(r.regions[0]).toMatchObject({ offset: 0, op: 'replace' })
    expect(r.regions[1]).toMatchObject({ offset: 1 + 64 + 1 + 64, op: 'replace' })
  })

  it('handles pure prefix/suffix length changes', () => {
    const r = diffBytes(Buffer.from('tail'), Buffer.from('headtail'))
    expect(r.regions).toHaveLength(1)
    expect(r.regions[0]).toMatchObject({ op: 'insert', offset: 0, sut: { len: 4 } })
  })

  it('caps region count and flags truncation of the region list', () => {
    const baseline = Buffer.from(
      Array.from({ length: 200 }, (_, i) => `EVT${i}${'y'.repeat(60)}`).join('|'),
    )
    const sut = Buffer.from(
      Array.from({ length: 200 }, (_, i) => `evt${i}${'y'.repeat(60)}`).join('|'),
    )
    const r = diffBytes(baseline, sut, 8)
    expect(r.equal).toBe(false)
    expect(r.regions.length).toBeLessThanOrEqual(8)
    expect(r.regionsTruncated).toBe(true)
  })
})

describe('compareHeaderPairs', () => {
  const ignoreNone = new Set<string>()

  it('reports missing, extra, and value-mismatch issues', () => {
    const baseline: [string, string][] = [
      ['content-type', 'application/json'],
      ['x-request-id', 'abc'],
      ['date', 'D'],
    ]
    const sut: [string, string][] = [
      ['content-type', 'text/plain'],
      ['date', 'D'],
      ['x-powered-by', 'sloppy'],
    ]
    const issues = compareHeaderPairs(baseline, sut, ignoreNone)
    expect(issues).toContainEqual(
      expect.objectContaining({ issue: 'value-mismatch', name: 'content-type', baselineValue: 'application/json', sutValue: 'text/plain' }),
    )
    expect(issues).toContainEqual(expect.objectContaining({ issue: 'missing', name: 'x-request-id' }))
    expect(issues).toContainEqual(expect.objectContaining({ issue: 'extra', name: 'x-powered-by' }))
  })

  it('ignores exactly the hop-by-hop set (case-insensitively) and nothing else', () => {
    const baseline: [string, string][] = [
      ['content-type', 'application/json'],
      ['Transfer-Encoding', 'chunked'],
      ['Connection', 'close'],
      ['date', 'D'],
    ]
    const sut: [string, string][] = [
      ['content-type', 'application/json'],
      ['transfer-encoding', 'chunked'],
      ['connection', 'keep-alive'],
      ['date', 'D'],
    ]
    expect(compareHeaderPairs(baseline, sut, ignoreNone)).toEqual([])
  })

  it('detects reordering of the same header multiset with the divergence position', () => {
    const baseline: [string, string][] = [
      ['date', 'D'],
      ['content-type', 'application/json'],
      ['cache-control', 'no-store'],
    ]
    const sut: [string, string][] = [
      ['content-type', 'application/json'],
      ['date', 'D'],
      ['cache-control', 'no-store'],
    ]
    const issues = compareHeaderPairs(baseline, sut, ignoreNone)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ issue: 'reordered', baselinePosition: 0 })
  })

  it('keeps duplicate headers position-wise', () => {
    const baseline: [string, string][] = [
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]
    const sut: [string, string][] = [
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=3'],
    ]
    const issues = compareHeaderPairs(baseline, sut, ignoreNone)
    expect(issues).toEqual([
      expect.objectContaining({ issue: 'value-mismatch', name: 'set-cookie', baselineValue: 'b=2', sutValue: 'b=3' }),
    ])
  })
})
