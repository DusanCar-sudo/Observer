/**
 * CLI end-to-end tests for `observer scan`.
 *
 * These matter more than they look. They make the **golden acceptance criterion reproducible in CI
 * without touching the Human's real `~/.dsh`**: a synthetic session containing an 891-call-style
 * thrash loop is built in-repo, and the whole pipeline (zstd decode -> normalise -> detect -> report)
 * is asserted against it. V8's "must fire within <=20 iterations" is therefore a test, not a claim
 * made once against one machine's data.
 *
 * The CLI is exercised as a subprocess, so argument handling, exit codes, and output shape are
 * covered too — none of which a unit test of the detector would reach.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCAN = join(HERE, '..', 'src', 'scan.ts')
const MIN = 60_000

function requireZstd(): void {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' })
  } catch {
    assert.fail('zstd is not on PATH; required to build synthetic session fixtures. Hard failure, not a skip.')
  }
}

interface Call {
  name: string
  args: object
  /** Result text; when a function, it is called with the occurrence index. */
  result: string | ((i: number) => string)
  isError?: boolean
  /** Gap before this call, in ms. */
  gapMs?: number
}

/** Build a synthetic DSH session directory containing one session with the given calls. */
function buildSession(root: string, id: string, calls: Call[], opts: { cwd?: string; origin?: string } = {}): string {
  const dir = join(root, '--synthetic-workspace--', id)
  mkdirSync(dir, { recursive: true })

  const recs: unknown[] = [{
    type: 'session',
    version: 4,
    id,
    createdAt: 1_700_000_000_000,
    cwd: opts.cwd ?? '/tmp/synthetic',
    ...(opts.origin === undefined ? {} : { origin: opts.origin, delegationDepth: 1 }),
  }]

  let seq = 1
  let t = 1_700_000_000_000
  const seen = new Map<string, number>()

  for (const c of calls) {
    t += c.gapMs ?? 1000
    const key = `${c.name}:${JSON.stringify(c.args)}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)

    const callId = `call_${seq}`
    recs.push({
      type: 'tool/call', seq, time: t,
      data: { turn: 1, step: seq, callId, name: c.name, arguments: JSON.stringify(c.args) },
    })
    seq += 1
    const text = typeof c.result === 'function' ? c.result(n) : c.result
    recs.push({
      type: 'tool/result', seq, time: t + 5,
      data: {
        turn: 1, step: seq,
        message: {
          role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
          content: [{ type: 'text', text }], isError: c.isError ?? false, id: `m_${callId}`,
        },
        meta: { cwd: opts.cwd ?? '/tmp/synthetic' },
      },
    })
    seq += 1
  }

  const plain = join(dir, 'in.jsonl')
  writeFileSync(plain, recs.map(r => JSON.stringify(r)).join('\n'), 'utf8')
  const out = join(dir, 'session.v4.jsonl.zstd')
  execFileSync('zstd', ['-q', '-f', '-o', out, plain])
  return dir
}

function run(args: string[], root: string) {
  return spawnSync(process.execPath, [SCAN, '--root', root, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  })
}

test('zstd is available', () => { requireZstd() })

test('GOLDEN CASE: a thrash loop fires at iteration 5, well inside the <=20 criterion', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-golden-${process.pid}-`))
  // Mirrors session e89e7501: the same bash command, byte-identical arguments, returning the same
  // small answer every time. 20 occurrences is enough to prove the fire point; the real one ran 891.
  buildSession(root, 'thrash-session', Array.from({ length: 20 }, () => ({
    name: 'bash',
    args: { command: "sed -n '21,33p' /proj/godot/scripts/world/zemun_expansion.gd", description: 'Show lines' },
    result: 'const x = 1\n'.repeat(20),
    gapMs: 11_600, // the real loop averaged ~11.6s between calls over 2.85h
  })))

  const r = run(['--json'], root)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.sessionsScanned, 1)

  const loops = out.sessions[0].loops
  assert.equal(loops.length, 1, 'exactly one loop finding expected')
  assert.equal(loops[0].toolName, 'bash')
  assert.equal(loops[0].iterationsAtFire, 5, 'must fire at the threshold, not after the fact')
  assert.ok(loops[0].iterationsAtFire <= 20, 'V8 acceptance criterion: fires within <=20 iterations')
  assert.equal(loops[0].totalOccurrences, 20)
  assert.ok(loops[0].wastedBytes > 0)
  rmSync(root, { recursive: true, force: true })
})

test('spaced identical polling does NOT fire — the false positive that shaped the rate window', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-spaced-${process.pid}-`))
  // This is the lead's own list_agents pattern: same input, same output, but ~20 min apart.
  buildSession(root, 'polling-session', Array.from({ length: 6 }, () => ({
    name: 'list_agents',
    args: {},
    result: '[{"target":"lead","status":"running"}]',
    gapMs: 20 * MIN,
  })))

  const r = run(['--json'], root)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.sessions[0].loops.length, 0, 'spaced polling is legitimate waiting, not thrashing')
  rmSync(root, { recursive: true, force: true })
})

test('the SAME pattern compressed into a burst DOES fire — rate is the discriminator', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-burst-${process.pid}-`))
  buildSession(root, 'burst-session', Array.from({ length: 6 }, () => ({
    name: 'list_agents',
    args: {},
    result: '[{"target":"lead","status":"running"}]',
    gapMs: 1000,
  })))

  const r = run(['--json'], root)
  const out = JSON.parse(r.stdout)
  assert.equal(out.sessions[0].loops.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('repeated input with CHANGING output does not fire, and is counted as polling', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-productive-${process.pid}-`))
  buildSession(root, 'productive-session', Array.from({ length: 12 }, () => ({
    name: 'bash',
    args: { command: './gradlew :app:assembleRelease' },
    result: (i: number) => `build attempt ${i}: ${i < 6 ? 'FAILED' : 'SUCCESS'}`,
    gapMs: 1000,
  })))

  const r = run(['--json'], root)
  const out = JSON.parse(r.stdout)
  assert.equal(out.sessions[0].loops.length, 0, 'each call returned new information')
  assert.ok(out.sessions[0].pollingGroups >= 1, 'but the input repetition is still reported, not hidden')
  rmSync(root, { recursive: true, force: true })
})

test('repeated SUCCESS fires, not only repeated failure (decision E4)', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-e4-${process.pid}-`))
  buildSession(root, 'success-loop', Array.from({ length: 8 }, () => ({
    name: 'bash',
    args: { command: 'ls /proj/out.png' },
    result: '/proj/out.png',
    isError: false,
    gapMs: 1000,
  })))

  const r = run(['--json'], root)
  const out = JSON.parse(r.stdout)
  assert.equal(out.sessions[0].loops.length, 1, 'E4: agents repeat commands that SUCCEED; an error-conditioned detector would miss this')
  rmSync(root, { recursive: true, force: true })
})

test('a differing `description` does not split the signature', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-desc-${process.pid}-`))
  const descs = ['Show lines to replace', 'Show _ready lines', 'again', 'Show exact lines', 'Show lines', 'once more']
  buildSession(root, 'desc-session', descs.map(description => ({
    name: 'bash',
    args: { command: "sed -n '21,33p' f.gd", description },
    result: 'identical output',
    gapMs: 1000,
  })))

  const r = run(['--json'], root)
  const out = JSON.parse(r.stdout)
  assert.equal(out.sessions[0].loops.length, 1)
  assert.equal(out.sessions[0].loops[0].totalOccurrences, 6)
  rmSync(root, { recursive: true, force: true })
})

test('multiple sessions are scanned and ranked by wasted bytes', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-multi-${process.pid}-`))
  buildSession(root, 'quiet-session', [
    { name: 'read', args: { file_path: '/a' }, result: 'aaa' },
    { name: 'read', args: { file_path: '/b' }, result: 'bbb' },
  ])
  buildSession(root, 'loud-session', Array.from({ length: 10 }, () => ({
    name: 'bash',
    args: { command: 'cat big.log' },
    result: 'x'.repeat(5000),
    gapMs: 1000,
  })))

  const r = run(['--json'], root)
  const out = JSON.parse(r.stdout)
  assert.equal(out.sessionsScanned, 2)
  assert.equal(out.sessions[0].session, 'loud-session', 'worst offender reported first')
  assert.equal(out.sessions[0].loops.length, 1)
  assert.equal(out.sessions[1].loops.length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('human-readable output names the session, the tool, and the avoidable calls', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-text-${process.pid}-`))
  buildSession(root, 'text-session', Array.from({ length: 30 }, () => ({
    name: 'bash',
    args: { command: 'sed -n 1,5p f.txt' },
    result: 'same',
    gapMs: 1000,
  })))

  const r = run([], root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /observe-only, no mutation, no model calls/)
  assert.match(r.stdout, /threshold: 5 within 10min/)
  assert.match(r.stdout, /bash x30 \(fired at 5\)/)
  assert.match(r.stdout, /further identical calls after the alarm point/)
  rmSync(root, { recursive: true, force: true })
})

test('--calibrate prints the repeat-group distribution used to choose the threshold', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-cal-${process.pid}-`))
  buildSession(root, 'cal-session', [
    ...Array.from({ length: 7 }, () => ({ name: 'bash', args: { command: 'same' }, result: 'same', gapMs: 1000 })),
    { name: 'read', args: { file_path: '/once' }, result: 'unique' },
  ])

  const r = run(['--calibrate'], root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /CALIBRATION: repeat-group size distribution/)
  assert.match(r.stdout, /total groups: 2/)
  assert.match(r.stdout, /groups with size >=  5: 1/)
  rmSync(root, { recursive: true, force: true })
})

test('unknown record types are NAMED in the report, not just counted', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-unknown-${process.pid}-`))
  const dir = buildSession(root, 'unknown-session', [
    { name: 'read', args: { file_path: '/a' }, result: 'aaa' },
  ])
  // Append two records of a type the reader does not know, then recompress.
  const extra = [
    { type: 'compaction/prune', seq: 900, time: 1, data: {} },
    { type: 'llm/retry', seq: 901, time: 2, data: {} },
  ]
  const file = join(dir, 'session.v4.jsonl.zstd')
  const decoded = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const plain = join(dir, 're.jsonl')
  writeFileSync(plain, `${decoded.trimEnd()}\n${extra.map(e => JSON.stringify(e)).join('\n')}\n`, 'utf8')
  execFileSync('zstd', ['-q', '-f', '-o', file, plain])

  const r = run([], root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /schema drift is reported, never silently ignored/)
  assert.match(r.stdout, /'compaction\/prune' x1/)
  assert.match(r.stdout, /'llm\/retry' x1/)
  rmSync(root, { recursive: true, force: true })
})

test('bad arguments exit 2 with a message on stderr, not a stack trace', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-args-${process.pid}-`))
  const bogus = run(['--nonsense'], root)
  assert.equal(bogus.status, 2)
  assert.match(bogus.stderr, /unknown argument --nonsense/)

  const badThreshold = run(['--threshold', '1'], root)
  assert.equal(badThreshold.status, 2)
  assert.match(badThreshold.stderr, /integer >= 2/)

  const badWindow = run(['--window', '0'], root)
  assert.equal(badWindow.status, 2)
  assert.match(badWindow.stderr, /positive number of minutes/)
  rmSync(root, { recursive: true, force: true })
})

test('an empty root exits 1 with a clear message rather than reporting a clean scan', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-empty-${process.pid}-`))
  const r = run([], root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no session files found/)
  rmSync(root, { recursive: true, force: true })
})

test('a clean session reports zero loops rather than failing or staying silent', () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-cli-clean-${process.pid}-`))
  buildSession(root, 'clean-session', [
    { name: 'read', args: { file_path: '/a' }, result: 'aaa' },
    { name: 'bash', args: { command: 'npm test' }, result: '41 passed' },
    { name: 'read', args: { file_path: '/b' }, result: 'bbb' },
  ])

  const r = run([], root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /loops found: 0/)
  assert.match(r.stdout, /No information-free repetition at or above the threshold/)
  rmSync(root, { recursive: true, force: true })
})
