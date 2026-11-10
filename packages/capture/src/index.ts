/**
 * @observer/capture — the V0a raw-byte logging tap.
 *
 * Records live DSH→qwen traffic verbatim (both directions), with zero mutation of
 * bodies: raw bytes in, raw bytes stored, raw bytes forwarded. `reasoning_content`
 * is absent from OpenAI's own ChoiceDelta schema — a typed tap would silently drop
 * 100% of reasoning on target one, so NOTHING here parses payloads on the
 * forwarding path. Parsing exists only as byte-level framing observation and
 * derived metadata (request line, status line, index fields).
 */

export * from './types.js'
export { CaptureRecorder, NULL_CAPTURE, type RecordingCapture, type RecorderLike } from './recorder.js'
export { startTap } from './tap.js'
export {
  startProxy,
  type ProxyCoreConfig,
  type ProxyCoreHandle,
  type ProxyEvent,
  type ProxyRequestInfo,
  type RouteDecision,
  type SyntheticResponse,
} from './proxy-core.js'
export { startReplayServer, type ReplayHandle, type ReplayOptions } from './replay.js'
export {
  findHead,
  spliceHostHeader,
  headValue,
  ResponseFramer,
  type ParsedHead,
  type FramingMode,
} from './http-lite.js'
export {
  redactHeadBytes,
  redactBodyBytes,
  redactCapture,
  SECRET_PATTERNS,
  type RedactedCaptureReport,
  type HeadRedactionResult,
  type BodyRedactionResult,
} from './redact.js'
