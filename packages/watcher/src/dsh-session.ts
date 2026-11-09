/**
 * Reader for DeepSeek Harness session logs — the passive watcher's input adapter.
 *
 * Format documented in `docs/recon/dsh-session-format.md`, decoded from real files rather than
 * from documentation. Layout on disk:
 *
 *   ~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
 *
 * Every line is `{type, seq, time, data}` except the `session` record, which carries its identity
 * at top level and has no `data`.
 *
 * TWO FORMAT HAZARDS, both hit during recon and handled here:
 *   1. `data.message` and `data.header` may arrive as an object OR as a JSON string depending on
 *      the record type. Never `JSON.parse` unconditionally — guard on `typeof`.
 *   2. The log carries the *logical* conversation, not wire request bodies. `request/header`
 *      parses to exactly `{config, tools}` and contains no `messages`. That is why byte-fidelity
 *      fixtures need the V0a tap, while detector fixtures can be derived from here today.
 *
 * Decoding streams rather than buffering: the largest session on this machine is 17 MB compressed,
 * and the decompressed JSONL is considerably larger.
 *
 * @module @observer/watcher/dsh-session
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** One logical tool invocation paired with its result, in session order. */
export interface ToolEvent {
  /** Session-record sequence number; the only strictly monotonic ordering available. */
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly name: string
  /** Original `arguments` JSON string, unmodified. Raw is truth. */
  readonly argsRaw: string
  /** Concatenated text content of the result, for hashing and byte accounting. */
  readonly resultText: string
  /** Byte cost of the result per study §3.3: text UTF-8 bytes + image `attachment.bytes`. */
  readonly resultBytes: number
  readonly isError: boolean
  /** Epoch ms of the `tool/call` record. */
  readonly time: number
  /** True once the matching `tool/result` was seen. Two calls corpus-wide never got one. */
  readonly hasResult: boolean
  /** Working directory from the result's `meta.cwd`, when present. */
  readonly cwd?: string
}

/** A completed todo snapshot, in the order the agent wrote it. */
export interface TodoSnapshot {
  readonly seq: number
  readonly time: number
  readonly completed: number
  readonly total: number
}

export interface DshSession {
  readonly id: string
  readonly version: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
  readonly path: string
  readonly events: ToolEvent[]
  readonly todos: TodoSnapshot[]
  /** Records whose type we did not recognise, by type — so schema drift is visible, not silent. */
  readonly unknownTypes: Map<string, number>
}

/** Parse a field that may be an object or a JSON string. Returns undefined rather than throwing. */
function coerce<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  }
  if (typeof value === 'object') return value as T
  return undefined
}

interface WireBlock {
  type?: string
  text?: string
  attachment?: { bytes?: number }
}

/**
 * Byte cost of a result's content, per study §3.3.
 *
 * The study's disclosed assumption is carried forward: image payloads are not stored in the log,
 * only their sizes, so `attachment.bytes` is taken as the true payload cost. Anything that is
 * neither text nor image is charged at its JSON-serialised length, which keeps unknown block
 * types accounted for instead of silently free.
 */
function resultBytes(content: unknown): { text: string; bytes: number } {
  const blocks = Array.isArray(content) ? (content as WireBlock[]) : []
  let text = ''
  let bytes = 0
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text += block.text
      bytes += Buffer.byteLength(block.text, 'utf8')
    } else if (block?.type === 'image') {
      bytes += block.attachment?.bytes ?? 0
    } else if (block !== null && typeof block === 'object') {
      const s = JSON.stringify(block)
      bytes += s.length
    }
  }
  return { text, bytes }
}

/** Decode one `session.v4.jsonl.zstd` file into a DshSession. */
export async function readDshSession(path: string): Promise<DshSession> {
  const zstd = spawn('zstd', ['-dc', '--quiet', path])

  let header: Record<string, unknown> = {}
  const pending = new Map<string, { index: number }>()
  const events: ToolEvent[] = []
  const todos: TodoSnapshot[] = []
  const unknownTypes = new Map<string, number>()

  const KNOWN = new Set([
    'session', 'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message',
    'assistant/message', 'system/message', 'tool/call', 'tool/result', 'request/header',
    'request/context', 'todo/write', 'agent/inbox/spliced', 'subagent/descriptor',
    'sandbox/mode', 'approval/policy', 'job/registered', 'job/settled', 'session/title',
    'session/end-seed',
  ])

  const rl = createInterface({ input: zstd.stdout, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      unknownTypes.set('(unparseable)', (unknownTypes.get('(unparseable)') ?? 0) + 1)
      continue
    }

    const type = String(rec.type ?? '')
    if (!KNOWN.has(type)) unknownTypes.set(type, (unknownTypes.get(type) ?? 0) + 1)

    const seq = Number(rec.seq ?? 0)
    const time = Number(rec.time ?? 0)

    if (type === 'session') {
      header = rec
      continue
    }

    const data = (rec.data ?? {}) as Record<string, unknown>

    if (type === 'tool/call') {
      const callId = String(data.callId ?? '')
      const ev: ToolEvent = {
        seq,
        turn: Number(data.turn ?? 0),
        step: Number(data.step ?? 0),
        callId,
        name: String(data.name ?? ''),
        argsRaw: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
        resultText: '',
        resultBytes: 0,
        isError: false,
        time,
        hasResult: false,
      }
      pending.set(callId, { index: events.length })
      events.push(ev)
      continue
    }

    if (type === 'tool/result') {
      const message = coerce<{
        toolCallId?: string
        content?: unknown
        isError?: boolean
      }>(data.message)
      const meta = coerce<{ cwd?: string }>(data.meta)
      const callId = String(message?.toolCallId ?? '')
      const hit = pending.get(callId)
      if (hit === undefined) continue
      const { text, bytes } = resultBytes(message?.content)
      const target = events[hit.index]
      if (target === undefined) continue
      // Replace rather than mutate in place: ToolEvent fields are readonly by design, so a
      // completed event is constructed whole. This keeps the array order stable.
      events[hit.index] = {
        ...target,
        resultText: text,
        resultBytes: bytes,
        isError: message?.isError === true,
        hasResult: true,
        ...(meta?.cwd === undefined ? {} : { cwd: meta.cwd }),
      }
      continue
    }

    if (type === 'todo/write') {
      const list = Array.isArray(data.todos) ? (data.todos as Array<{ status?: string }>) : []
      todos.push({
        seq,
        time,
        completed: list.filter(t => t?.status === 'completed').length,
        total: list.length,
      })
    }
  }

  await new Promise<void>(resolve => {
    zstd.on('close', () => resolve())
    zstd.on('error', () => resolve())
  })

  return {
    id: String(header.id ?? ''),
    version: Number(header.version ?? 0),
    ...(header.cwd === undefined ? {} : { cwd: String(header.cwd) }),
    ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
    ...(header.origin === undefined ? {} : { origin: String(header.origin) }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: Number(header.delegationDepth) }),
    path,
    events,
    todos,
    unknownTypes,
  }
}

/** Find every `session.v*.jsonl.zstd` under a DSH sessions root. */
export async function listDshSessionFiles(root: string): Promise<string[]> {
  const out: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) {
        out.push(full)
      }
    }
  }

  await walk(root, 0)
  return out.sort()
}

/** Total bytes on disk of a session file, for reporting. Zero if unavailable. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
