/**
 * Loop detector — the repetition-without-new-information alarm.
 *
 * WHY THIS RULE AND NOT ANOTHER
 * -----------------------------
 * The naive rule, "the same call repeated N times is a loop", is wrong, and the corpus proves it.
 * `docs/research/noise-drift-study.md` T14 lists `list_agents {}` at 31 repeats and
 * `read_image /tmp/<T>` at 27 — an agent legitimately polling its teammates, and legitimately
 * looking at a sequence of distinct screenshots. Neither is thrashing.
 *
 * So the rule here requires **both** halves to repeat: the same normalised call signature AND the
 * same result hash. Identical input producing byte-identical output adds **zero new information**
 * — there is no world state in which the Nth call taught the agent something the (N-1)th did not.
 * That is the actual pathology, and it is grounded in the dominant corpus example: 891
 * byte-identical `sed -n '21,33p'` calls over 2.85 hours inside a single turn, *each returning the
 * same <=483-byte answer*. Productive polling fails the second half and does not fire.
 *
 * TWO FURTHER GROUNDED CHOICES
 * ----------------------------
 * - Repetition is counted **regardless of error status**. Decision E4: only 612 bytes of duplicate
 *   content across the whole corpus carried `isError: true`. Agents repeat commands that SUCCEED —
 *   polling and lost-thread re-reads. An error-conditioned detector misses the dominant pathology.
 * - Calls with **no observed result are never alarmed on**. We cannot claim two outputs matched if
 *   we did not see one. Conservative by construction: a false accusation is far more damaging than
 *   a missed loop, because it is the failure that gets Observer switched off.
 *
 * THE RATE CONDITION, AND WHY IT WAS ADDED AFTER FIRST RUNNING THIS
 * -----------------------------------------------------------------
 * Input-plus-output identity is necessary but NOT sufficient, and the first run of this detector
 * proved it by accusing its own author. Scanning the Observer project's own session flagged
 * `list_agents {}` six times over **101 minutes** — that was the lead legitimately polling whether
 * a teammate had finished, and the output matched simply because nothing had changed yet.
 *
 * "Zero new information" is not the same as "pathological". An idempotent read returning the same
 * answer twice can mean the agent is correctly waiting. What distinguishes the corpus pathology is
 * **rate**: 891 identical `sed` calls inside a *single turn*, roughly one every 11.6 seconds. So
 * the alarm requires N occurrences **within a sliding time window**, not N occurrences ever.
 * Spaced polling never accumulates N inside the window; a thrash loop accumulates it almost
 * immediately. This costs one tunable parameter and removes the false-positive class entirely.
 *
 * @module @observer/detectors/loop
 */

import { createHash } from 'node:crypto'
import { callSignature, describeSignature } from './normalise.ts'
import type { DshSession, ToolEvent } from '../../watcher/src/dsh-session.ts'

/** Default alarm threshold. Justified by calibration against the corpus, not by taste — see below. */
export const DEFAULT_THRESHOLD = 5

/**
 * Default sliding window for the rate condition, in ms.
 *
 * Chosen against the measured pathology: 891 calls over 2.85 h averages ~11.6 s between calls, so
 * a 10-minute window contains roughly 50 occurrences and fires immediately. Legitimate polling in
 * the same corpus (`list_agents {}` at ~20 min intervals) never reaches 5 inside the window.
 * Calibrate with `--calibrate` before trusting this number for a different workload.
 */
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000

export interface LoopFinding {
  readonly sessionId: string
  readonly toolName: string
  /** Normalised signature; match key, not for display. */
  readonly signature: string
  /** First 16 hex of sha256 over the result text. */
  readonly resultHash: string
  readonly threshold: number
  /** Sliding window the threshold was evaluated over, in ms. */
  readonly windowMs: number
  /** Sequence number and time of the first occurrence. */
  readonly firstSeq: number
  readonly firstTime: number
  /** Where the alarm fired — the Nth occurrence inside one window. */
  readonly fireSeq: number
  readonly fireTime: number
  readonly iterationsAtFire: number
  /** Span of just the occurrences that triggered the alarm, i.e. how fast the burst was. */
  readonly burstSpanMs: number
  /** Final total across the whole session, so the cost of not intervening is visible. */
  readonly totalOccurrences: number
  readonly spanMs: number
  /** Bytes of result repeated after the first occurrence: (n-1) * resultBytes. */
  readonly wastedBytes: number
  readonly resultBytes: number
  /** Truncated call arguments, for the report. */
  readonly callSample: string
  /** Truncated result, for the report. */
  readonly resultSample: string
}

export interface LoopScanResult {
  readonly findings: LoopFinding[]
  /** Calls seen, and calls skipped for want of a result. */
  readonly callsSeen: number
  readonly callsWithoutResult: number
  /**
   * Repeat groups whose *input* repeated but whose *output* differed — legitimate polling. Tracked
   * so the two-sided rule can be shown to be doing work rather than merely asserted.
   */
  readonly inputRepeatButOutputDiffers: number
  /** Every repeat-group size, for threshold calibration. */
  readonly groupSizes: number[]
}

export interface DetectOptions {
  /** Occurrences of the same (signature, resultHash) inside one window before firing. */
  readonly threshold?: number
  /** Sliding rate window in ms. See DEFAULT_WINDOW_MS for how this was chosen. */
  readonly windowMs?: number
  /**
   * Strip `/tmp/...` to a placeholder. Defaults to `false` — see normalise.ts. Enabling it merges
   * distinct temp files and will produce false alarms.
   */
  readonly stripTempPaths?: boolean
}

interface Group {
  signature: string
  resultHash: string
  name: string
  count: number
  /** Occurrence times, pruned to the trailing window. Used for the rate condition. */
  windowTimes: number[]
  windowSeqs: number[]
  firstSeq: number
  firstTime: number
  fireSeq: number
  fireTime: number
  burstSpanMs: number
  lastSeq: number
  lastTime: number
  resultBytes: number
  callSample: string
  resultSample: string
  fired: boolean
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

function hashResult(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Scan one session's tool events for information-free repetition.
 *
 * Events must already be in session order; the DSH reader guarantees this because it preserves
 * record order and `seq` is monotonic within a session file.
 */
export function detectLoops(session: DshSession, options: DetectOptions = {}): LoopScanResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error(`loop detector: threshold must be an integer >= 2, got ${String(threshold)}`)
  }
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`loop detector: windowMs must be a positive finite number, got ${String(windowMs)}`)
  }

  // Keyed on (signature, resultHash) — the pair that defines "no new information".
  const groups = new Map<string, Group>()
  // Keyed on signature alone, to count input-repeats whose output legitimately differed.
  const bySignature = new Map<string, Set<string>>()

  const findings: LoopFinding[] = []
  let callsSeen = 0
  let callsWithoutResult = 0

  for (const ev of session.events) {
    callsSeen += 1

    if (!ev.hasResult) {
      // No observed output => cannot assert the output repeated. Skip rather than guess.
      callsWithoutResult += 1
      continue
    }

    const signature = callSignature(ev.name, ev.argsRaw, {
      stripTempPaths: options.stripTempPaths ?? false,
    })
    const resultHash = hashResult(ev.resultText)
    const key = `${signature}\u0001${resultHash}`

    let sigHashes = bySignature.get(signature)
    if (sigHashes === undefined) {
      sigHashes = new Set<string>()
      bySignature.set(signature, sigHashes)
    }
    sigHashes.add(resultHash)

    let group = groups.get(key)
    if (group === undefined) {
      group = {
        signature,
        resultHash,
        name: ev.name,
        count: 0,
        windowTimes: [],
        windowSeqs: [],
        firstSeq: ev.seq,
        firstTime: ev.time,
        fireSeq: 0,
        fireTime: 0,
        burstSpanMs: 0,
        lastSeq: ev.seq,
        lastTime: ev.time,
        resultBytes: ev.resultBytes,
        callSample: truncate(ev.argsRaw, 160),
        resultSample: truncate(ev.resultText, 160),
        fired: false,
      }
      groups.set(key, group)
    }

    group.count += 1
    group.lastSeq = ev.seq
    group.lastTime = ev.time

    // Rate condition: keep only occurrences inside the trailing window. A group that repeats
    // slowly never accumulates `threshold` here, which is what separates a thrash loop from an
    // agent legitimately polling an idempotent read and getting the same answer back.
    group.windowTimes.push(ev.time)
    group.windowSeqs.push(ev.seq)
    const cutoff = ev.time - windowMs
    while (group.windowTimes.length > 0 && (group.windowTimes[0] ?? 0) < cutoff) {
      group.windowTimes.shift()
      group.windowSeqs.shift()
    }

    if (!group.fired && group.windowTimes.length >= threshold) {
      group.fired = true
      group.fireSeq = ev.seq
      group.fireTime = ev.time
      group.burstSpanMs = Math.max(0, ev.time - (group.windowTimes[0] ?? ev.time))
      findings.push({
        sessionId: session.id,
        toolName: ev.name,
        signature,
        resultHash,
        threshold,
        windowMs,
        firstSeq: group.firstSeq,
        firstTime: group.firstTime,
        fireSeq: ev.seq,
        fireTime: ev.time,
        iterationsAtFire: group.windowTimes.length,
        burstSpanMs: group.burstSpanMs,
        // totalOccurrences / spanMs / wastedBytes are finalised after the pass.
        totalOccurrences: 0,
        spanMs: 0,
        wastedBytes: 0,
        resultBytes: ev.resultBytes,
        callSample: group.callSample,
        resultSample: group.resultSample,
      })
    }
  }

  // Finalise totals now that every group has been fully counted.
  const finalised: LoopFinding[] = findings.map(f => {
    const g = groups.get(`${f.signature}\u0001${f.resultHash}`)
    if (g === undefined) return f
    return {
      ...f,
      totalOccurrences: g.count,
      spanMs: Math.max(0, g.lastTime - g.firstTime),
      wastedBytes: Math.max(0, (g.count - 1) * g.resultBytes),
    }
  })

  let inputRepeatButOutputDiffers = 0
  for (const hashes of bySignature.values()) {
    if (hashes.size > 1) inputRepeatButOutputDiffers += 1
  }

  const groupSizes = [...groups.values()].map(g => g.count)

  // Worst first: the loops that cost the most, then the ones that ran longest.
  finalised.sort((a, b) => b.wastedBytes - a.wastedBytes || b.totalOccurrences - a.totalOccurrences)

  return {
    findings: finalised,
    callsSeen,
    callsWithoutResult,
    inputRepeatButOutputDiffers,
    groupSizes,
  }
}

/** Display helper shared by the CLI and tests. */
export function describeFinding(f: LoopFinding): string {
  return `${f.toolName} x${f.totalOccurrences} (fired at ${f.iterationsAtFire})` +
    ` ${(f.wastedBytes / 1024).toFixed(1)}kB wasted` +
    ` over ${(f.spanMs / 60000).toFixed(1)}min :: ${describeSignature(f.signature, 110)}`
}
