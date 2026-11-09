/**
 * @observer/rig — the differential fidelity harness.
 *
 * The rig replays each fixture twice (direct to a scripted mock upstream, and via a
 * system-under-test) and diffs status, headers, BODY BYTES WITH OFFSETS, the request
 * bytes the upstream saw, arrival boundaries, inter-arrival gaps, TTFB, and
 * truncation offsets. Zero runtime dependencies, loopback-only, zero network.
 *
 * Ground rule: comparisons happen on raw bytes and arrival timelines. Nothing on a
 * comparison path parses a payload — a rig that parses before comparing cannot detect
 * chunk coalescing or a dropped field its own schema does not know about, which are
 * precisely the failure classes Observer exists to catch.
 */

export * from './types.js'
export {
  HOP_BY_HOP_HEADERS,
  SPLIT_GAP_MS,
  HeadParser,
  ResponseDecoder,
  isHopByHop,
  rawHeaderPairs,
  findHeader,
  findAllHeaders,
  serializeHead,
  parseStatusLine,
  parseRequestLine,
  toDecodedHead,
} from './http.js'
export { runClient, DEFAULT_CLIENT_TIMEOUT_MS, type ClientRunOptions } from './client.js'
export { startMockUpstream, type MockUpstream } from './upstream.js'
export { mulberry32, bigChatBody, runGenerator } from './generators.js'
export {
  loadCorpus,
  loadFixture,
  findCorpusDir,
  expectedArrivalsOf,
  sha256,
  FixtureIntegrityError,
  DEFAULT_TIMING,
  LOOSE_TTFB_BUDGET_MS,
} from './fixtures.js'
export { diffBytes, diffRuns, compareHeaderPairs, MAX_DIFF_REGIONS, type ByteCompareResult } from './diff.js'
export { formatReport, formatDiff, formatRegions, formatHeaderIssues, formatTimeline } from './report.js'
export { runFidelityCheck } from './run.js'
export { createProxySut, type ProxyHooks, type BodyStrategy } from './testdoubles/common.js'
export { ReferencePipe } from './testdoubles/reference-pipe.js'
export {
  JsonRoundTripPipe,
  TypedModelPipe,
  SloppyHeadersPipe,
  CoalescingPipe,
  BufferingPipe,
  SseRewritingPipe,
  FAULTY_DOUBLES,
  canonicalStringify,
} from './testdoubles/faulty.js'
