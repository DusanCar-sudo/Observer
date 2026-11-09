/**
 * Argument normalisation for tool-call signatures.
 *
 * PORTED, NOT INVENTED. The rules below are taken verbatim from
 * `docs/research/noise-drift-study.md` §3.2, which was executed against the real 73-session
 * corpus. Keeping the shipped detector's normalisation identical to the measured one is what
 * makes the study's numbers a valid calibration for this code rather than a loose analogy.
 *
 * ONE DELIBERATE DEVIATION, and it matters. The study discloses that stripping `/tmp/...` paths
 * "can merge two different temp files into one signature (false duplicate)", and indeed its own
 * T14 table shows `read_image /tmp/<T>` at 27 repeats — an aggregate of *distinct* screenshots.
 * For measuring noise volume that is acceptable and was disclosed. For **alarming** it is not: a
 * detector that merges distinct inputs will accuse an agent of looping when it is doing ordinary
 * work. So `stripTempPaths` is a flag, and the detector defaults to `false`.
 *
 * @module @observer/detectors/normalise
 */

/** Volatile substrings replaced with placeholders, in the study's order. */
const VOLATILE: ReadonlyArray<readonly [RegExp, string]> = [
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<UUID>'],
  [/\bcall_[0-9a-zA-Z_]{8,}\b/g, '<CALLID>'],
  [
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    '<TS>',
  ],
  [/\b1[6-9]\d{11}\b/g, '<EPOCHMS>'],
  [/\/tmp\/\S+/g, '/tmp/<T>'],
  [/\/var\/folders\/\S+/g, '<VARFOLDERS>'],
  [/\btmp\.\w{4,}\b/g, 'tmp.<T>'],
  [/\b[0-9a-f]{16,}\b/g, '<HEX>'],
]

/** Index of the `/tmp` rule within VOLATILE, so it can be skipped without duplicating the table. */
const TEMP_PATH_INDEX = 4

/** Keys dropped at any nesting level: human-facing labels that cannot affect tool output. */
const METADATA_KEYS: ReadonlySet<string> = new Set(['description', 'justification'])

/** Epoch-milliseconds pattern applied to bare integer values as well as string contents. */
const EPOCH_MS = /^1[6-9]\d{11}$/

export interface NormaliseOptions {
  /**
   * Replace `/tmp/...` with a placeholder. `true` reproduces the study's noise measurement;
   * `false` (the detector default) keeps distinct temp paths distinct so that alarms are not
   * raised on legitimately different inputs.
   */
  readonly stripTempPaths?: boolean
  /** Drop `description` / `justification`. The study found this changes duplicate counts by ~5%. */
  readonly dropMetadata?: boolean
}

function stripVolatile(text: string, stripTempPaths: boolean): string {
  let out = text
  for (let i = 0; i < VOLATILE.length; i += 1) {
    if (i === TEMP_PATH_INDEX && !stripTempPaths) continue
    const [re, placeholder] = VOLATILE[i]!
    out = out.replace(re, placeholder)
  }
  return out
}

/**
 * Recursively normalise a parsed JSON value: drop metadata keys, sort object keys, preserve array
 * order (order is semantically meaningful, e.g. inside shell commands), and strip volatile
 * substrings from every string and epoch-shaped number.
 */
function normaliseValue(value: unknown, opts: Required<NormaliseOptions>): unknown {
  if (Array.isArray(value)) return value.map(v => normaliseValue(v, opts))

  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      if (opts.dropMetadata && METADATA_KEYS.has(key)) continue
      out[key] = normaliseValue(src[key], opts)
    }
    return out
  }

  if (typeof value === 'string') return stripVolatile(value, opts.stripTempPaths)
  if (typeof value === 'number' && EPOCH_MS.test(String(value))) return '<EPOCHMS>'
  return value
}

/**
 * Produce the stable signature for a tool call: `name` plus its normalised arguments.
 *
 * Falls back to the raw string (still volatile-stripped) if `rawArgs` is not parseable JSON. The
 * study recorded zero parse failures corpus-wide, but the fallback keeps the detector honest on
 * traffic it has not seen rather than throwing on the request path.
 */
export function callSignature(
  name: string,
  rawArgs: string,
  options: NormaliseOptions = {},
): string {
  const opts: Required<NormaliseOptions> = {
    stripTempPaths: options.stripTempPaths ?? false,
    dropMetadata: options.dropMetadata ?? true,
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return `${name}\u0000${stripVolatile(rawArgs, opts.stripTempPaths)}`
  }

  return `${name}\u0000${JSON.stringify(normaliseValue(parsed, opts))}`
}

/** Human-readable form of a signature, for reports. Never used for matching. */
export function describeSignature(signature: string, maxLen = 140): string {
  const idx = signature.indexOf('\u0000')
  const name = idx === -1 ? signature : signature.slice(0, idx)
  const rest = idx === -1 ? '' : signature.slice(idx + 1)
  const flat = rest.length > maxLen ? `${rest.slice(0, maxLen)}…` : rest
  return flat ? `${name} ${flat}` : name
}
