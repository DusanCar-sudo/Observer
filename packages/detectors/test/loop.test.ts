/**
 * Loop detector tests — `node:test`, zero dependencies, run with `node --test`.
 *
 * These lock in the three behaviours that were each learned the hard way:
 *  1. identical input + identical output is what fires (not repetition alone),
 *  2. the rate window separates a thrash loop from legitimate spaced polling,
 *  3. a call whose result was never observed is never alarmed on.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { detectLoops, DEFAULT_THRESHOLD } from '../src/loop.ts'
import type { DshSession, ToolEvent } from '../../watcher/src/dsh-session.ts'

function ev(partial: Partial<ToolEvent> & { seq: number; time: number }): ToolEvent {
  return {
    step: 0,
    turn: 0,
    callId: `call_${partial.seq}`,
    name: 'bash',
    argsRaw: '{"command":"ls"}',
    resultText: 'same',
    resultBytes: 4,
    isError: false,
    hasResult: true,
    ...partial,
  } as ToolEvent
}

function session(events: ToolEvent[], id = 'test'): DshSession {
  return {
    id,
    version: 4,
    path: '/dev/null',
    events,
    todos: [],
    unknownTypes: new Map(),
  }
}

const MIN = 60_000

test('fires when identical input yields identical output N times inside the window', () => {
  const t0 = 1_700_000_000_000
  const events = Array.from({ length: 7 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 1000 }),
  )
  const r = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN })
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0]!.iterationsAtFire, 5)
  assert.equal(r.findings[0]!.totalOccurrences, 7)
})

test('does NOT fire when the output differs each time (productive polling)', async () => {
  const t0 = 1_700_000_000_000
  const events = Array.from({ length: 20 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 1000, resultText: `status-${i}`, resultBytes: 10 }),
  )
  const r = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN })
  assert.equal(r.findings.length, 0, 'changing output means new information; not a loop')
  assert.equal(r.inputRepeatButOutputDiffers, 1, 'but the input repeat is still counted and reported')
})

test('does NOT fire on identical output spread outside the rate window', () => {
  // This is the false positive the first real run produced: `list_agents {}` six times over
  // 101 minutes. Same input, same output, entirely legitimate — the world had not changed yet.
  const t0 = 1_700_000_000_000
  const events = Array.from({ length: 6 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 20 * MIN, name: 'list_agents', argsRaw: '{}' }),
  )
  const r = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN })
  assert.equal(r.findings.length, 0, 'spaced polling must not be accused of thrashing')
})

test('DOES fire when the same spaced pattern is compressed into a burst', () => {
  const t0 = 1_700_000_000_000
  const events = Array.from({ length: 6 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 1000, name: 'list_agents', argsRaw: '{}' }),
  )
  const r = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN })
  assert.equal(r.findings.length, 1, 'rate is the discriminator, not the tool')
})

test('never alarms on a call whose result was not observed', () => {
  const t0 = 1_700_000_000_000
  const events = Array.from({ length: 9 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 1000, hasResult: false, resultText: '', resultBytes: 0 }),
  )
  const r = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN })
  assert.equal(r.findings.length, 0)
  assert.equal(r.callsWithoutResult, 9)
})

test('fires on repeated SUCCESS, not only repeated failure (decision E4)', () => {
  // The corpus carries only 612 bytes of duplicate content with isError:true. Agents repeat
  // commands that SUCCEED. An error-conditioned detector would miss the dominant pathology.
  const t0 = 1_700_000_000_000
  const ok = Array.from({ length: 6 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 1000, isError: false }),
  )
  assert.equal(detectLoops(session(ok), { threshold: 5, windowMs: 10 * MIN }).findings.length, 1)

  const err = Array.from({ length: 6 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 1000, isError: true }),
  )
  assert.equal(detectLoops(session(err), { threshold: 5, windowMs: 10 * MIN }).findings.length, 1)
})

test('volatile values in arguments do not defeat matching', () => {
  const t0 = 1_700_000_000_000
  // Same command, different description text and a different timestamp inside it.
  const args = [
    '{"command":"sed -n \'21,33p\' f.gd","description":"Show lines to replace"}',
    '{"command":"sed -n \'21,33p\' f.gd","description":"Show _ready lines for edit"}',
    '{"command":"sed -n \'21,33p\' f.gd","description":"again 2026-11-09T21:14:03Z"}',
    '{"command":"sed -n \'21,33p\' f.gd","description":"Show lines"}',
    '{"command":"sed -n \'21,33p\' f.gd","description":"Show exact lines"}',
  ]
  const events = args.map((argsRaw, i) => ev({ seq: i, time: t0 + i * 1000, argsRaw }))
  const r = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN })
  assert.equal(r.findings.length, 1, 'description is metadata and must not split the signature')
})

test('distinct /tmp paths are NOT merged by default', () => {
  // The study discloses that stripping /tmp merges distinct temp files into one signature, which
  // is acceptable for measuring noise volume but would produce false alarms. Detector default is
  // to keep them distinct.
  const t0 = 1_700_000_000_000
  const paths = ['/tmp/shot-a.png', '/tmp/shot-b.png', '/tmp/shot-c.png', '/tmp/shot-d.png', '/tmp/shot-e.png']
  const events = paths.map((p, i) =>
    ev({ seq: i, time: t0 + i * 1000, name: 'read_image', argsRaw: `{"file_path":"${p}"}` }),
  )
  const strict = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN })
  assert.equal(strict.findings.length, 0, 'five different screenshots are not a loop')

  const loose = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN, stripTempPaths: true })
  assert.equal(loose.findings.length, 1, 'and the study-compatible mode demonstrably does merge them')
})

test('wasted bytes and burst span are computed, not left as placeholders', () => {
  const t0 = 1_700_000_000_000
  const events = Array.from({ length: 8 }, (_, i) =>
    ev({ seq: i, time: t0 + i * 2000, resultBytes: 1000, resultText: 'x'.repeat(1000) }),
  )
  const f = detectLoops(session(events), { threshold: 5, windowMs: 10 * MIN }).findings[0]!
  assert.equal(f.totalOccurrences, 8)
  assert.equal(f.wastedBytes, 7000, '(n-1) * resultBytes')
  assert.equal(f.burstSpanMs, 8000, '5 occurrences at 2s spacing = 8s from first to fifth')
})

test('threshold below 2 is rejected rather than silently alarming on everything', () => {
  assert.throws(() => detectLoops(session([]), { threshold: 1 }), /integer >= 2/)
  assert.throws(() => detectLoops(session([]), { windowMs: 0 }), /positive finite/)
})

test('default threshold matches the corpus-calibrated value', () => {
  // `observer scan --calibrate` over 75 real sessions / 7,525 repeat groups: 7,446 occur exactly
  // once, and there is an empty band between size 6 and size 21. 5 sits at that elbow.
  assert.equal(DEFAULT_THRESHOLD, 5)
})
