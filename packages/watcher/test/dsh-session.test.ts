/**
 * Watcher tests — the DSH session-log reader.
 *
 * These build synthetic `session.v4.jsonl.zstd` fixtures in-repo rather than reading the Human's
 * real `~/.dsh`, so the suite is deterministic, private, and runnable in CI.
 *
 * The cases here are the format hazards documented in `docs/recon/dsh-session-format.md`, each of
 * which was discovered by reading real files rather than from documentation:
 *   - `data.message` / `data.header` may arrive as an object OR as a JSON string
 *   - image blocks carry no payload, only `attachment.bytes`
 *   - a `tool/call` may never receive its `tool/result`
 *   - the `session` record carries identity at TOP LEVEL and has no `data`
 *   - unknown and unparseable records must be reported, never silently dropped
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDshSession, listDshSessionFiles } from '../src/dsh-session.ts'

/** Fail loudly rather than silently skipping — a skipped check is not a passing one. */
function requireZstd(): void {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' })
  } catch {
    assert.fail(
      'zstd is not on PATH. The watcher reads session.v4.jsonl.zstd and cannot be tested without it. ' +
      'Install zstd (apt: zstd, brew: zstd). This is a hard failure, not a skip.',
    )
  }
}

let counter = 0
function writeSession(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), `observer-watcher-${process.pid}-${counter++}-`))
  const file = join(dir, 'session.v4.jsonl.zstd')
  const jsonl = records.map(r => JSON.stringify(r)).join('\n')
  const plain = join(dir, 'in.jsonl')
  writeFileSync(plain, jsonl, 'utf8')
  execFileSync('zstd', ['-q', '-f', '-o', file, plain])
  return file
}

const sessionRecord = {
  type: 'session',
  version: 4,
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  createdAt: 1_700_000_000_000,
  cwd: '/tmp/fake-project',
  parentSession: 'session-parent-0000',
  isSeeded: false,
  origin: 'subagent',
  delegationDepth: 1,
  agentPreset: 'standard',
}

function call(seq: number, name: string, args: object, extra: Record<string, unknown> = {}) {
  return {
    type: 'tool/call',
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    data: { turn: 1, step: seq, callId: `call_${seq}`, name, arguments: JSON.stringify(args), ...extra },
  }
}

function result(seq: number, callId: string, content: unknown[], isError = false, asString = false) {
  const message = {
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content,
    isError,
    id: `msg_${callId}`,
  }
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    data: {
      turn: 1,
      step: seq,
      // HAZARD: this field is an object in some records and a JSON string in others.
      message: asString ? JSON.stringify(message) : message,
      meta: { cwd: '/tmp/fake-project' },
    },
  }
}

test('zstd is available (hard requirement, not a skip)', () => {
  requireZstd()
})

test('reads session identity from the top-level record, which has no data field', async () => {
  requireZstd()
  const file = writeSession([sessionRecord])
  const s = await readDshSession(file)
  assert.equal(s.id, sessionRecord.id)
  assert.equal(s.version, 4)
  assert.equal(s.cwd, '/tmp/fake-project')
  assert.equal(s.parentSession, 'session-parent-0000')
  assert.equal(s.origin, 'subagent')
  assert.equal(s.delegationDepth, 1)
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('joins tool/call to tool/result by callId and preserves raw arguments', async () => {
  requireZstd()
  const args = { command: "sed -n '1,5p' f.txt", description: 'show lines' }
  const file = writeSession([
    sessionRecord,
    call(1, 'bash', args),
    result(2, 'call_1', [{ type: 'text', text: 'line1\nline2\n' }]),
  ])
  const s = await readDshSession(file)
  assert.equal(s.events.length, 1)
  const ev = s.events[0]!
  assert.equal(ev.name, 'bash')
  assert.equal(ev.callId, 'call_1')
  assert.equal(ev.hasResult, true)
  assert.equal(ev.isError, false)
  assert.equal(ev.cwd, '/tmp/fake-project')
  // Raw is truth: the arguments string must survive unmodified, not be re-serialised.
  assert.equal(ev.argsRaw, JSON.stringify(args))
  assert.equal(ev.resultText, 'line1\nline2\n')
  assert.equal(ev.resultBytes, Buffer.byteLength('line1\nline2\n', 'utf8'))
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('HAZARD: data.message arriving as a JSON string parses identically to an object', async () => {
  requireZstd()
  const content = [{ type: 'text', text: 'same payload' }]
  const asObj = writeSession([sessionRecord, call(1, 'read', { file_path: '/a' }), result(2, 'call_1', content, false, false)])
  const asStr = writeSession([sessionRecord, call(1, 'read', { file_path: '/a' }), result(2, 'call_1', content, false, true)])

  const a = await readDshSession(asObj)
  const b = await readDshSession(asStr)

  assert.equal(a.events[0]!.hasResult, true, 'object form must join')
  assert.equal(b.events[0]!.hasResult, true, 'string form must join too - unconditional JSON.parse would throw here')
  assert.equal(a.events[0]!.resultText, b.events[0]!.resultText)
  assert.equal(a.events[0]!.resultBytes, b.events[0]!.resultBytes)
  rmSync(join(asObj, '..'), { recursive: true, force: true })
  rmSync(join(asStr, '..'), { recursive: true, force: true })
})

test('HAZARD: image blocks carry no payload, so attachment.bytes is the cost', async () => {
  requireZstd()
  const file = writeSession([
    sessionRecord,
    call(1, 'read_image', { file_path: '/shot.png' }),
    result(2, 'call_1', [
      { type: 'text', text: 'abc' },
      { type: 'image', attachment: { bytes: 12345 } },
    ]),
  ])
  const s = await readDshSession(file)
  const ev = s.events[0]!
  assert.equal(ev.resultText, 'abc')
  // 3 text bytes + 12345 declared image bytes. The payload itself is absent from the log; this is
  // the study's disclosed assumption, carried forward deliberately.
  assert.equal(ev.resultBytes, 3 + 12345)
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('HAZARD: an unknown block type is charged at its JSON length, never silently free', async () => {
  requireZstd()
  const exotic = { type: 'future-block', payload: 'xyz' }
  const file = writeSession([
    sessionRecord,
    call(1, 'bash', { command: 'true' }),
    result(2, 'call_1', [exotic]),
  ])
  const s = await readDshSession(file)
  assert.equal(s.events[0]!.resultBytes, JSON.stringify(exotic).length)
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('HAZARD: a call with no result stays hasResult:false and is never fabricated', async () => {
  requireZstd()
  const file = writeSession([sessionRecord, call(1, 'bash', { command: 'sleep 999' })])
  const s = await readDshSession(file)
  assert.equal(s.events.length, 1)
  assert.equal(s.events[0]!.hasResult, false)
  assert.equal(s.events[0]!.resultText, '')
  assert.equal(s.events[0]!.resultBytes, 0)
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('a result whose call never arrived is dropped, not orphaned into the event list', async () => {
  requireZstd()
  const file = writeSession([sessionRecord, result(2, 'call_nonexistent', [{ type: 'text', text: 'x' }])])
  const s = await readDshSession(file)
  assert.equal(s.events.length, 0)
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('isError propagates, because decision E4 depends on knowing it is usually false', async () => {
  requireZstd()
  const file = writeSession([
    sessionRecord,
    call(1, 'bash', { command: 'ok' }),
    result(2, 'call_1', [{ type: 'text', text: 'fine' }], false),
    call(3, 'bash', { command: 'bad' }),
    result(4, 'call_3', [{ type: 'text', text: 'boom' }], true),
  ])
  const s = await readDshSession(file)
  assert.deepEqual(s.events.map(e => e.isError), [false, true])
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('todo/write snapshots count completed vs total, in order', async () => {
  requireZstd()
  const file = writeSession([
    sessionRecord,
    { type: 'todo/write', seq: 5, time: 1, data: { todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ] } },
    { type: 'todo/write', seq: 9, time: 2, data: { todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'pending' },
    ] } },
  ])
  const s = await readDshSession(file)
  assert.equal(s.todos.length, 2)
  assert.deepEqual(s.todos.map(t => t.completed), [1, 2])
  assert.deepEqual(s.todos.map(t => t.total), [3, 3])
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('unknown record types are NAMED and counted, never silently dropped', async () => {
  requireZstd()
  // These are real types observed in the corpus that this reader does not yet interpret. Naming
  // them is what surfaced compaction/prune and llm/retry as signals worth having.
  const file = writeSession([
    sessionRecord,
    { type: 'compaction/prune', seq: 3, time: 1, data: {} },
    { type: 'compaction/prune', seq: 4, time: 2, data: {} },
    { type: 'llm/retry', seq: 5, time: 3, data: {} },
    { type: 'something/brand-new', seq: 6, time: 4, data: {} },
  ])
  const s = await readDshSession(file)
  assert.equal(s.unknownTypes.get('compaction/prune'), 2)
  assert.equal(s.unknownTypes.get('llm/retry'), 1)
  assert.equal(s.unknownTypes.get('something/brand-new'), 1)
  rmSync(join(file, '..'), { recursive: true, force: true })
})

test('an unparseable line is counted and does not abort the rest of the file', async () => {
  requireZstd()
  const dir = mkdtempSync(join(tmpdir(), `observer-watcher-bad-${process.pid}-`))
  const file = join(dir, 'session.v4.jsonl.zstd')
  const plain = join(dir, 'in.jsonl')
  writeFileSync(plain, [
    JSON.stringify(sessionRecord),
    'this is not json at all',
    JSON.stringify(call(1, 'bash', { command: 'echo hi' })),
    '{ truncated',
  ].join('\n'), 'utf8')
  execFileSync('zstd', ['-q', '-f', '-o', file, plain])

  const s = await readDshSession(file)
  assert.equal(s.events.length, 1, 'the good record after the bad ones must still parse')
  assert.equal(s.unknownTypes.get('(unparseable)'), 2)
  rmSync(dir, { recursive: true, force: true })
})

test('preserves record order, which the loop detector relies on', async () => {
  requireZstd()
  const recs: unknown[] = [sessionRecord]
  for (let i = 1; i <= 6; i += 1) {
    recs.push(call(i, 'bash', { command: `cmd-${i}` }))
    recs.push(result(i + 100, `call_${i}`, [{ type: 'text', text: `out-${i}` }]))
  }
  const s = await readDshSession(writeSession(recs))
  assert.deepEqual(s.events.map(e => e.name + ':' + e.argsRaw.slice(12, 17)), [
    'bash:cmd-1', 'bash:cmd-2', 'bash:cmd-3', 'bash:cmd-4', 'bash:cmd-5', 'bash:cmd-6',
  ].map(x => x.replace('bash:', 'bash:')))
  assert.deepEqual(s.events.map(e => e.resultText), ['out-1', 'out-2', 'out-3', 'out-4', 'out-5', 'out-6'])
})

test('listDshSessionFiles finds nested session files and ignores everything else', async () => {
  requireZstd()
  const root = mkdtempSync(join(tmpdir(), `observer-watcher-list-${process.pid}-`))
  const wsDir = join(root, '--some-workspace--', 'session-abc')
  execFileSync('mkdir', ['-p', wsDir])
  writeFileSync(join(wsDir, 'session.v4.jsonl.zstd'), 'x')
  writeFileSync(join(wsDir, 'session.lock'), '')
  writeFileSync(join(wsDir, 'notes.txt'), 'ignore me')
  // A v3 file must also be found: the corpus contains v3-only sessions.
  const v3Dir = join(root, '--other--', 'session-def')
  execFileSync('mkdir', ['-p', v3Dir])
  writeFileSync(join(v3Dir, 'session.v3.jsonl.zstd'), 'x')

  const found = await listDshSessionFiles(root)
  assert.equal(found.length, 2)
  assert.ok(found.some(f => f.endsWith('session.v4.jsonl.zstd')))
  assert.ok(found.some(f => f.endsWith('session.v3.jsonl.zstd')))
  assert.ok(!found.some(f => f.includes('session.lock') || f.includes('notes.txt')))
  rmSync(root, { recursive: true, force: true })
})

test('a missing or unreadable file yields no sessions rather than throwing', async () => {
  const found = await listDshSessionFiles('/nonexistent/path/that/does/not/exist')
  assert.deepEqual(found, [])
})
