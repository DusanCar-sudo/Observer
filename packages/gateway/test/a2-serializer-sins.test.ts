/**
 * A2 — THE THREE SERIALIZER SINS, as named regression tests.
 *
 * On target one these sins are SILENT at runtime: qwen applies no prefix check
 * and reasoning carries no signature, so a serializer that drops unknown fields,
 * drops empty fields, or reorders keys produces NO error — only cache loss and
 * corrupted reasoning (spec §3, §9). These tests are the only detection that
 * exists. They assert on RAW BYTES seen by the upstream, never on parsed shapes.
 *
 * The final test is the structural guard: the gateway source contains no JSON
 * parser or serializer at all. The first `JSON.parse` in this package is the
 * beginning of the end of byte identity — if you are reading this because you
 * need to parse a body, you need to parse a COPY (V3's rule), and you need to
 * update this test deliberately, in review, not quietly.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '@observer/rig'
import { exchangeViaGateway, fixture } from './helpers.js'

describe('A2 sin (i) — dropped unknown fields', () => {
  it('reasoning_content and x_custom reach the upstream byte-identically', async () => {
    const fx = await fixture('req-reasoning-history')
    const r = await exchangeViaGateway(fx)
    const sent = fx.request.body.toString('utf8')
    const seen = r.upstream!.body.toString('utf8')
    // reasoning_content is ABSENT from OpenAI's own schema (§4A.1): a typed
    // round-trip deletes it. Assert the EXACT wire spelling survived — derived
    // from the fixture itself so wording changes cannot break the criterion.
    const rc = /"reasoning_content":"[^"]*"/.exec(sent)
    expect(rc, 'fixture must carry reasoning_content').not.toBeNull()
    expect(seen).toContain(rc![0])
    const xc = /"x_custom":\{"nested":\{"deep":true\},"flag":""\}/.exec(sent)
    expect(xc, 'fixture must carry x_custom').not.toBeNull()
    expect(seen).toContain(xc![0])
    expect(r.upstream!.bodySha256).toBe(sha256(fx.request.body))
  }, 60_000)
})

describe('A2 sin (ii) — dropped empty fields', () => {
  it('reasoning_content:"", content:null, stop:[], empty tool output survive', async () => {
    const fx = await fixture('req-empty-fields')
    const r = await exchangeViaGateway(fx)
    const seen = r.upstream!.body.toString('utf8')
    expect(seen).toContain('"reasoning_content":""') // some dialects REQUIRE this (§4A.4)
    expect(seen).toContain('"content":null')
    expect(seen).toContain('"stop":[]')
    expect(seen).toContain('"content":""') // empty tool result
    expect(r.upstream!.bodySha256).toBe(sha256(fx.request.body))
  }, 60_000)
})

describe('A2 sin (iii) — reordered keys / reformatted numbers & escapes', () => {
  it('number spellings survive byte-exactly (1.0, 0.900, 0.00, 1e3, 2048.0)', async () => {
    const fx = await fixture('req-number-formats')
    const r = await exchangeViaGateway(fx)
    const seen = r.upstream!.body.toString('utf8')
    expect(seen).toContain('"temperature":1.0')
    expect(seen).toContain('"top_p":0.900')
    expect(seen).toContain('"presence_penalty":0.0')
    expect(seen).toContain('"frequency_penalty":0.00')
    expect(seen).toContain('"max_tokens":1e3')
    expect(seen).toContain('"max_completion_tokens":2048.0')
    expect(r.upstream!.bodySha256).toBe(sha256(fx.request.body))
  }, 60_000)

  it('\\uXXXX escapes, surrogate pairs and \\/ survive byte-exactly alongside literal UTF-8', async () => {
    const fx = await fixture('req-unicode-escapes')
    const r = await exchangeViaGateway(fx)
    const seen = r.upstream!.body.toString('utf8')
    expect(seen).toContain('\\u00e9') // escaped form must NOT be decoded to é
    expect(seen).toContain('\\ud83d\\ude00') // surrogate pair stays escaped
    expect(seen).toContain('\\/') // escaped solidus stays escaped
    expect(seen).toContain('café 中文 😀') // literal form must NOT be escaped
    expect(r.upstream!.bodySha256).toBe(sha256(fx.request.body))
  }, 60_000)
})

describe('A2 structural guard — no JSON codec exists in the gateway', () => {
  function srcFiles(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...srcFiles(full))
      else if (e.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('packages/gateway/src contains zero JSON.parse / JSON.stringify calls', () => {
    const src = path.join(import.meta.dirname, '..', 'src')
    const files = srcFiles(src)
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const f of files) {
      // Strip comments so documentation ABOUT the sins does not trip the scan.
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(code, `${f} calls JSON.parse`).not.toMatch(/JSON\s*\.\s*parse\s*\(/)
      expect(code, `${f} calls JSON.stringify`).not.toMatch(/JSON\s*\.\s*stringify\s*\(/)
    }
  })
})
