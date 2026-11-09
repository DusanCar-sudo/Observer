#!/usr/bin/env node
/**
 * Heading-manifest check for Observer's design documents.
 *
 * WHY THIS EXISTS
 * ---------------
 * Inserting a section immediately before an existing heading has silently deleted that heading
 * TWICE in this repo: once in `docs/research/protocol-fidelity.md` (lost `## 5. OpenAI Responses
 * API`) and once in `docs/research/dmn-execution-landscape.md` (lost `## 6. What is not known and
 * must be measured`). Both were caused by an edit whose `old_string` was the heading itself and
 * whose `new_string` did not repeat it.
 *
 * A deleted heading fails no test, breaks no build, and leaves the prose perfectly readable —
 * which is exactly the class of silent damage Observer exists to detect in other agents' work. It
 * would be embarrassing to ship a supervisor that cannot protect its own documents from it.
 *
 * So: every heading in every design doc is recorded in a manifest, and CI asserts the manifest is
 * a subset of the file. Removals fail the build. Additions are reported so the manifest can be
 * refreshed deliberately.
 *
 * USAGE
 * -----
 *   node tools/check-doc-headings.mjs            # check; exit 1 on any removed heading
 *   node tools/check-doc-headings.mjs --update   # rewrite the manifest from current files
 *
 * The discipline this replaces, and which is still worth following when editing by hand: a
 * section-insertion edit must include the *following* heading in both the old and the new string,
 * so the heading cannot be dropped by omission.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const MANIFEST = join(ROOT, 'tools', 'doc-headings.json')
const SCAN_DIRS = ['docs', '.']
const SCAN_EXTENSIONS = new Set(['.md'])
const SKIP = new Set(['node_modules', '.git', '.verify', '.study-tmp', 'packages', 'dist'])

const UPDATE = process.argv.includes('--update')

/** Collect markdown files, skipping directories that hold no authored prose. */
function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectFiles(full, out)
    else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) out.push(full)
  }
  return out
}

/**
 * Extract headings verbatim, in order.
 * Headings inside fenced code blocks are ignored: a ```-fenced example containing "# foo" is not
 * document structure, and counting it would make the manifest churn on unrelated edits.
 */
function headingsOf(text) {
  const out = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (m) out.push(`${m[1]} ${m[2]}`)
  }
  return out
}

function buildManifest() {
  const manifest = {}
  const roots = SCAN_DIRS.map(d => join(ROOT, d)).filter(d => statSync(d).isDirectory())
  const seen = new Set()
  for (const root of roots) {
    for (const file of collectFiles(root)) {
      const rel = relative(ROOT, file)
      if (seen.has(rel)) continue
      seen.add(rel)
      manifest[rel] = headingsOf(readFileSync(file, 'utf8'))
    }
  }
  return manifest
}

const current = buildManifest()

if (UPDATE) {
  writeFileSync(MANIFEST, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  const total = Object.values(current).reduce((n, h) => n + h.length, 0)
  console.log(`doc-headings: manifest updated — ${Object.keys(current).length} files, ${total} headings.`)
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch {
  console.error('doc-headings: no manifest at tools/doc-headings.json.')
  console.error('  Create it with: node tools/check-doc-headings.mjs --update')
  process.exit(1)
}

const removed = []
const added = []
const missingFiles = []

for (const [file, headings] of Object.entries(baseline)) {
  if (!(file in current)) {
    // A deleted or renamed document is a legitimate refactor, but it must be deliberate.
    missingFiles.push(file)
    continue
  }
  const have = new Set(current[file])
  for (const h of headings) if (!have.has(h)) removed.push([file, h])
}
for (const [file, headings] of Object.entries(current)) {
  if (!(file in baseline)) {
    added.push([file, '(new file)'])
    continue
  }
  const knew = new Set(baseline[file])
  for (const h of headings) if (!knew.has(h)) added.push([file, h])
}

if (removed.length || missingFiles.length) {
  console.error('doc-headings: FAILED — document structure lost.\n')
  for (const [file, h] of removed) console.error(`  REMOVED  ${file}\n           ${h}`)
  for (const file of missingFiles) console.error(`  MISSING FILE  ${file}`)
  console.error(`
  A removed heading almost always means an edit inserted a section before it and failed to
  repeat it. Restore the heading, or if the removal was intentional:
      node tools/check-doc-headings.mjs --update
`)
  process.exit(1)
}

if (added.length) {
  console.log(`doc-headings: ok — ${added.length} new heading(s) not yet in the manifest:`)
  for (const [file, h] of added) console.log(`  ADDED  ${file}\n         ${h}`)
  console.log('  Refresh with: node tools/check-doc-headings.mjs --update')
} else {
  console.log('doc-headings: ok — all recorded headings present.')
}
