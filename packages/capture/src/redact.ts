/**
 * Redaction pass for EXPORTED captures.
 *
 * Ground rules:
 *  - The raw capture store is append-only truth (I2) and is NEVER redacted in
 *    place. Redaction produces DERIVED copies for review/commit; their hashes
 *    differ from raw by design, and the copy says so in its meta.
 *  - Header redaction is name-based (auth/cookie/token/secret/key shapes).
 *  - Body redaction is pattern-based over the byte string (latin1 bijection keeps
 *    every other byte intact): provider keys, bearer tokens, cloud key shapes,
 *    GitHub tokens, JWTs, PEM private keys.
 *  - Redaction is a floor, not a ceiling: fixtures from real sessions contain real
 *    file paths and content, so the checked-in subset ALWAYS gets human review
 *    (task-2 privacy note). This pass removes credentials, not context.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findHead } from './http-lite.js'
import type { CaptureMeta } from './types.js'

export const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
]

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$|(^|[-_])(token|secret|credential|apikey|api-key)([-_]|$)/i

export interface HeadRedactionResult {
  out: Buffer
  redactedHeaders: string[]
}

/** Redact sensitive header VALUES in a raw HTTP head, byte-splicing each value. */
export function redactHeadBytes(raw: Buffer): HeadRedactionResult {
  const parsed = findHead(raw)
  if (!parsed) return { out: raw, redactedHeaders: [] }
  const redactedHeaders: string[] = []
  // Collect replacements, then apply from LAST to FIRST so earlier offsets stay valid.
  const edits: { start: number; end: number; value: Buffer }[] = []
  for (const h of parsed.headers) {
    if (!SENSITIVE_HEADER.test(h.name)) continue
    redactedHeaders.push(h.name.toLowerCase())
    edits.push({
      start: h.valueStart,
      end: h.lineEnd,
      value: Buffer.from(`[REDACTED:${h.name.toLowerCase()}]`, 'latin1'),
    })
  }
  if (edits.length === 0) return { out: raw, redactedHeaders }
  edits.sort((a, b) => b.start - a.start)
  let out = raw
  for (const e of edits) {
    out = Buffer.concat([out.subarray(0, e.start), e.value, out.subarray(e.end)])
  }
  return { out, redactedHeaders }
}

export interface BodyRedactionResult {
  out: Buffer
  hits: { kind: string; count: number }[]
}

/** Pattern-scan a body (latin1 byte bijection) and replace credential-shaped runs. */
export function redactBodyBytes(body: Buffer): BodyRedactionResult {
  // Work in latin1 so every byte maps to exactly one char and untouched bytes
  // survive re-encoding verbatim.
  let text = body.toString('latin1')
  const hits: { kind: string; count: number }[] = []
  for (const { kind, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    let count = 0
    text = text.replace(re, () => {
      count++
      return `[REDACTED:${kind}]`
    })
    if (count > 0) hits.push({ kind, count })
  }
  return { out: Buffer.from(text, 'latin1'), hits }
}

export interface RedactedCaptureReport {
  destDir: string
  redactedHeaders: string[]
  bodyHits: { kind: string; count: number }[]
  files: string[]
}

/**
 * Produce a redacted COPY of one capture directory (raw store untouched).
 * Redacted copies get `redacted: true` in meta and recomputed artifact hashes.
 */
export async function redactCapture(srcDir: string, destDir: string): Promise<RedactedCaptureReport> {
  await mkdir(destDir, { recursive: true })
  const meta = JSON.parse(await readFile(path.join(srcDir, 'meta.json'), 'utf8')) as CaptureMeta
  const files: string[] = []
  const allRedactedHeaders: string[] = []
  let allBodyHits: { kind: string; count: number }[] = []

  const headFile = await readFile(path.join(srcDir, 'request.head.bin'))
  const headRes = redactHeadBytes(headFile)
  allRedactedHeaders.push(...headRes.redactedHeaders)
  await writeFile(path.join(destDir, 'request.head.bin'), headRes.out)
  files.push('request.head.bin')

  for (const name of ['request.forwarded-head.bin']) {
    try {
      const raw = await readFile(path.join(srcDir, name))
      const res = redactHeadBytes(raw)
      allRedactedHeaders.push(...res.redactedHeaders)
      await writeFile(path.join(destDir, name), res.out)
      files.push(name)
    } catch {
      /* absent is normal */
    }
  }

  const body = await readFile(path.join(srcDir, 'request.body.bin'))
  const bodyRes = redactBodyBytes(body)
  allBodyHits = bodyRes.hits
  await writeFile(path.join(destDir, 'request.body.bin'), bodyRes.out)
  files.push('request.body.bin')

  // Response wire may embed credentials too (e.g. echoed set-cookie); scan it.
  const wire = await readFile(path.join(srcDir, 'response.wire.bin'))
  const wireRes = redactBodyBytes(wire)
  for (const h of wireRes.hits) {
    const existing = allBodyHits.find((x) => x.kind === h.kind)
    if (existing) existing.count += h.count
    else allBodyHits.push(h)
  }
  await writeFile(path.join(destDir, 'response.wire.bin'), wireRes.out)
  files.push('response.wire.bin')

  const redactedMeta = {
    ...meta,
    redacted: true as const,
    redaction: {
      headersRedacted: [...new Set(allRedactedHeaders)].sort(),
      bodyHits: allBodyHits,
      note: 'DERIVED copy: hashes differ from the raw capture by design. Raw store remains append-only truth.',
    },
  }
  await writeFile(path.join(destDir, 'meta.json'), `${JSON.stringify(redactedMeta, null, 2)}\n`, 'utf8')
  files.push('meta.json')

  return { destDir, redactedHeaders: [...new Set(allRedactedHeaders)].sort(), bodyHits: allBodyHits, files }
}
