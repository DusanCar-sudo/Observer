#!/usr/bin/env node
/**
 * Extract the `request/header` record (config + tools) from a real DSH session log.
 *
 * Provenance tool for fixtures/derived/dsh-qwen-40-tools.header.json. Read-only with
 * respect to ~/.dsh: it only decompresses and reads. Requires `zstd` on PATH.
 *
 * Usage:
 *   node tools/extract-dsh-header.mjs <path/to/session.v4.jsonl.zstd> <out.json>
 *
 * Note (recon §6): `request/header.data.header` deserialises to an OBJECT, not a JSON
 * string — guard with a typeof check rather than JSON.parse-ing unconditionally.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [sessionFile, outFile] = process.argv.slice(2)
if (!sessionFile || !outFile) {
  console.error('usage: node tools/extract-dsh-header.mjs <session.v4.jsonl.zstd> <out.json>')
  process.exit(2)
}

const jsonl = execFileSync('zstd', ['-dc', sessionFile], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
let found = null
for (const line of jsonl.split('\n')) {
  if (!line) continue
  const rec = JSON.parse(line)
  if (rec.type === 'request/header' && rec.data?.header) {
    found = rec.data.header
    break
  }
}
if (!found) {
  console.error('no request/header record found in', sessionFile)
  process.exit(1)
}
if (typeof found === 'string') found = JSON.parse(found)

// Sensitivity scan: refuse to write anything that looks like it carries user paths or secrets.
const text = JSON.stringify(found)
const patterns = [/\/home\/[a-zA-Z0-9_.-]+/, /sk-[a-zA-Z0-9]{8,}/, /api[_-]?key/i, /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/i]
for (const p of patterns) {
  const m = p.exec(text)
  if (m) {
    console.error(`REFUSING to write: extracted header matches sensitive pattern ${p} at ${JSON.stringify(m[0])}`)
    console.error('Sanitise deliberately (and record it in fixtures/derived/PROVENANCE.md) before committing.')
    process.exit(1)
  }
}

writeFileSync(outFile, `${JSON.stringify(found, null, 2)}\n`, 'utf8')
console.log(
  `wrote ${outFile}: provider=${found.config?.provider} model=${found.config?.model} tools=${Array.isArray(found.tools) ? found.tools.length : 'n/a'} bytes=${text.length}`,
)
