/**
 * `observer scan` — run the observe-only detectors over real DeepSeek Harness session logs.
 *
 * This is the watcher path: read-only, no gateway, no mutation, no model calls. It works today
 * against the sessions already on disk, which is why it is the first piece of Observer that
 * produces something an operator can look at.
 *
 *   node packages/cli/src/scan.ts                     # report loops across all sessions
 *   node packages/cli/src/scan.ts --calibrate         # measure the threshold from data
 *   node packages/cli/src/scan.ts --session e89e7501  # one session
 *   node packages/cli/src/scan.ts --json              # machine-readable
 *
 * NOTE ON IMPORTS: these are relative and cross package boundaries, which is deliberately
 * temporary. It lets the tool run on Node 26's native TypeScript with zero install step and zero
 * changes to the workspace lockfile while `packages/rig` is mid-flight. Once the workspace linking
 * settles these become `@observer/watcher` and `@observer/detectors`.
 *
 * @module @observer/cli/scan
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { listDshSessionFiles, readDshSession } from '../../watcher/src/dsh-session.ts'
import { detectLoops, describeFinding, DEFAULT_THRESHOLD, DEFAULT_WINDOW_MS } from '../../detectors/src/loop.ts'

interface Args {
  root: string
  threshold: number
  windowMs: number
  calibrate: boolean
  session?: string
  json: boolean
  limit: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: join(homedir(), '.dsh', 'sessions'),
    threshold: DEFAULT_THRESHOLD,
    windowMs: DEFAULT_WINDOW_MS,
    calibrate: false,
    json: false,
    limit: 25,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--calibrate') args.calibrate = true
    else if (a === '--json') args.json = true
    else if (a === '--root') args.root = String(argv[++i] ?? args.root)
    else if (a === '--threshold') args.threshold = Number(argv[++i])
    else if (a === '--window') args.windowMs = Number(argv[++i]) * 60_000
    else if (a === '--session') args.session = String(argv[++i] ?? '')
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: observer scan [--root DIR] [--threshold N] [--window MINUTES] [--calibrate] [--session ID] [--json] [--limit N]\n',
      )
      process.exit(0)
    } else {
      process.stderr.write(`scan: unknown argument ${a}\n`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(args.threshold) || args.threshold < 2) {
    process.stderr.write(`scan: --threshold must be an integer >= 2, got ${String(args.threshold)}\n`)
    process.exit(2)
  }
  if (!Number.isFinite(args.windowMs) || args.windowMs <= 0) {
    process.stderr.write(`scan: --window must be a positive number of minutes, got ${String(args.windowMs / 60000)}\n`)
    process.exit(2)
  }
  return args
}

function ms(min: number): string {
  return min >= 60 ? `${(min / 60).toFixed(1)}h` : `${min.toFixed(1)}min`
}

/**
 * Print the distribution of repeat-group sizes so the alarm threshold is chosen from the corpus
 * rather than from taste. This is the calibration the detector's DEFAULT_THRESHOLD depends on.
 */
function reportCalibration(sizes: number[], threshold: number): void {
  const buckets = new Map<number, number>()
  for (const s of sizes) buckets.set(s, (buckets.get(s) ?? 0) + 1)
  const keys = [...buckets.keys()].sort((a, b) => a - b)

  process.stdout.write('\n=== CALIBRATION: repeat-group size distribution ===\n')
  process.stdout.write('A group is one (normalised call signature, result hash) pair — i.e. calls\n')
  process.stdout.write('that repeated BOTH input and output, so each repeat added zero information.\n\n')
  process.stdout.write('  size   groups   cumulative>=size\n')

  let cumulative = 0
  const total = sizes.length
  for (const k of keys.reverse()) {
    cumulative += buckets.get(k) ?? 0
    const marker = k === threshold ? '   <-- current threshold' : ''
    process.stdout.write(
      `  ${String(k).padStart(4)}   ${String(buckets.get(k)).padStart(6)}   ${String(cumulative).padStart(8)}${marker}\n`,
    )
  }

  const ge = (n: number) => sizes.filter(s => s >= n).length
  process.stdout.write(`\n  total groups: ${total}\n`)
  for (const n of [2, 3, 4, 5, 8, 10, 20, 50]) {
    process.stdout.write(`  groups with size >= ${String(n).padStart(2)}: ${ge(n)} (${((ge(n) / Math.max(1, total)) * 100).toFixed(2)}%)\n`)
  }
  process.stdout.write('\n  Pick the threshold in the gap between ordinary repetition and pathology.\n')
  process.stdout.write('  Groups of size 2-3 are usually legitimate (a re-read, a retry that worked).\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  let files = await listDshSessionFiles(args.root)
  // Bind to a local: narrowing on `args.session` does not survive into the callback, because TS
  // cannot know the property was not reassigned between the check and the call.
  const sessionFilter = args.session
  if (sessionFilter) files = files.filter(f => f.includes(sessionFilter))

  if (files.length === 0) {
    process.stderr.write(`scan: no session files found under ${args.root}\n`)
    process.exit(1)
  }

  const allSizes: number[] = []
  const unknownTypes = new Map<string, number>()
  interface Row {
    session: string
    cwd: string
    origin: string
    calls: number
    findings: ReturnType<typeof detectLoops>['findings']
    polling: number
  }
  const rows: Row[] = []

  for (const file of files) {
    const session = await readDshSession(file)
    const scan = detectLoops(session, { threshold: args.threshold, windowMs: args.windowMs })
    allSizes.push(...scan.groupSizes)

    for (const [type, n] of session.unknownTypes) {
      unknownTypes.set(type, (unknownTypes.get(type) ?? 0) + n)
    }

    rows.push({
      session: session.id || file,
      cwd: session.cwd ?? '?',
      origin: session.origin ?? 'root',
      calls: scan.callsSeen,
      findings: scan.findings,
      polling: scan.inputRepeatButOutputDiffers,
    })
  }

  if (args.calibrate) {
    reportCalibration(allSizes, args.threshold)
    return
  }

  rows.sort((a, b) => {
    const aw = a.findings.reduce((n, f) => n + f.wastedBytes, 0)
    const bw = b.findings.reduce((n, f) => n + f.wastedBytes, 0)
    return bw - aw
  })

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      root: args.root,
      threshold: args.threshold,
      windowMs: args.windowMs,
      sessionsScanned: rows.length,
      unknownRecordTypes: Object.fromEntries(unknownTypes),
      sessions: rows.map(r => ({
        session: r.session,
        cwd: r.cwd,
        origin: r.origin,
        calls: r.calls,
        pollingGroups: r.polling,
        loops: r.findings,
      })),
    }, null, 2)}\n`)
    return
  }

  const withLoops = rows.filter(r => r.findings.length > 0)
  const totalFindings = rows.reduce((n, r) => n + r.findings.length, 0)
  const totalWasted = rows.reduce((n, r) => n + r.findings.reduce((m, f) => m + f.wastedBytes, 0), 0)
  const totalCalls = rows.reduce((n, r) => n + r.calls, 0)
  const totalPolling = rows.reduce((n, r) => n + r.polling, 0)

  process.stdout.write(`Observer scan — observe-only, no mutation, no model calls\n`)
  process.stdout.write(`root: ${args.root}\n`)
  process.stdout.write(`sessions: ${rows.length}   tool calls: ${totalCalls}   threshold: ${args.threshold} within ${(args.windowMs / 60000).toFixed(0)}min\n`)
  process.stdout.write(`loops found: ${totalFindings} across ${withLoops.length} sessions   repeated output: ${(totalWasted / 1048576).toFixed(2)} MB\n`)
  process.stdout.write(`input repeated but output differed (legitimate polling, NOT alarmed): ${totalPolling} groups\n`)

  let shown = 0
  for (const row of rows) {
    if (row.findings.length === 0) continue
    if (shown >= args.limit) {
      process.stdout.write(`\n… ${withLoops.length - shown} more sessions with findings (raise --limit)\n`)
      break
    }
    shown += 1
    const wasted = row.findings.reduce((n, f) => n + f.wastedBytes, 0)
    process.stdout.write(`\n── ${row.session.slice(0, 8)}  ${row.cwd}  [${row.origin}]  ${row.calls} calls, ${(wasted / 1024).toFixed(0)} kB repeated\n`)
    for (const f of row.findings.slice(0, 6)) {
      process.stdout.write(`   ${describeFinding(f)}\n`)
      process.stdout.write(`      first seq ${f.firstSeq} -> fired seq ${f.fireSeq}; result ${f.resultBytes} B\n`)
      if (f.totalOccurrences > 20) {
        const avoidable = f.totalOccurrences - f.iterationsAtFire
        process.stdout.write(`      ${avoidable} further identical calls after the alarm point, spanning ${ms(f.spanMs / 60000)}\n`)
      }
    }
    if (row.findings.length > 6) process.stdout.write(`   … ${row.findings.length - 6} more\n`)
  }

  if (totalFindings === 0) {
    process.stdout.write('\nNo information-free repetition at or above the threshold.\n')
  }

  const unknownTotal = [...unknownTypes.values()].reduce((a, b) => a + b, 0)
  if (unknownTotal > 0) {
    // Named, not counted. An aggregate number tells the operator that something was skipped;
    // only the type names tell them whether it is harmless or whether the schema moved under us.
    const named = [...unknownTypes.entries()].sort((a, b) => b[1] - a[1])
    process.stdout.write(`\nnote: ${unknownTotal} record(s) skipped as unrecognised — schema drift is reported, never silently ignored:\n`)
    for (const [type, n] of named.slice(0, 12)) {
      process.stdout.write(`   ${type === '(unparseable)' ? type : `'${type}'`} x${n}\n`)
    }
    if (named.length > 12) process.stdout.write(`   … ${named.length - 12} more types\n`)
  }
}

await main()
