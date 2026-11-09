/**
 * observer-dsh-plugin-session-id
 * ==============================
 * The declared-identity half of V6, as a DSH (cordis) plugin: when DSH makes an
 * inference call that carries a session id, add ONE header —
 * `X-Observer-Session: <sessionId>` — so an Observer gateway can resolve the
 * session declared-first instead of inferring it (T1/Q-R2: no declared ID ⇒
 * observe-only, permanently).
 *
 * WHY THIS IS THE MOST DANGEROUS THIRTY LINES IN THE PROJECT, and the discipline
 * that follows (lead's constraints, 2026-11-09):
 * The host waterfall (`llm-pi-ai/request-headers`, dsh-llm-pi-ai README §Request
 * headers) FAILS THE INFERENCE CALL when a contributor throws — fail-CLOSED,
 * before dispatch. A supervisor that can break the supervised agent by throwing
 * is worse than no supervisor (invariant I1). Therefore:
 *
 *   1. Our listener body is one try-block that contributes NOTHING on any error
 *      whatsoever — non-string sessionId, a Headers implementation that rejects
 *      set(), a request object whose getter throws, a host context shaped
 *      differently than documented. The only acceptable failure behaviour is
 *      "Observer contributed nothing".
 *   2. It sets exactly one header and never reads, modifies, or deletes any
 *      other. (Harness attribution is applied after all contributors anyway, so
 *      user-agent cannot be corrupted — but we do not give ourselves the
 *      opportunity.)
 *   3. Absent/invalid sessionId ⇒ emit nothing. That composes with Q-R2: no
 *      declared ID ⇒ Observer runs observe-only for that call. A degradation we
 *      designed for, not a bug.
 *   4. Trivially removable: one file, one registration, zero other surface.
 *      Disabling = deleting the plugin entry from the DSH profile.
 *
 * ONE DELIBERATE INTERPRETATION, stated for review: `next()` is called OUTSIDE
 * our try-block and its errors PROPAGATE. next() runs the downstream chain —
 * other contributors and the host's inner callback. If a downstream contributor
 * throws, the host contract is that the call fails with REQUEST_HEADERS; our
 * swallowing it would send a request another plugin tried to veto and would mask
 * a real fault. Constraint 1 ("returns headers untouched on anything
 * whatsoever") is implemented for everything WE can cause: our own code cannot
 * throw, and a missing/non-function `next` degrades to returning `headers`
 * untouched rather than crashing.
 *
 * INSTALLATION (Human/lead action — the dev sandbox treats ~/.dsh as read-only):
 *   add to the DSH profile's package.json dependencies:
 *     "observer-dsh-plugin-session-id": "file:<repo>/packages/capture/plugin"
 *   and enable it per the profile's plugin configuration. Remove that entry to
 *   uninstall; nothing else references it.
 *
 * WIRE VERIFICATION: the V0a tap (packages/capture) records request heads raw —
 * the first live capture run through the tap shows this header arriving (or not)
 * byte-for-byte. Until that run, behaviour is verified by unit tests only
 * (packages/capture/test/plugin-session-id.test.ts).
 */

export const HEADER_NAME = 'X-Observer-Session'
export const WATERFALL_EVENT = 'llm-pi-ai/request-headers'

export function apply(ctx) {
  try {
    if (!ctx || typeof ctx.on !== 'function') return // malformed host: contribute nothing, silently
    ctx.on(WATERFALL_EVENT, onPiAiRequestHeaders)
  } catch {
    // Registration itself must never take the host down (constraint 1, extended
    // to the cordis surface: a ctx that is not the shape the README describes).
  }
}

export function onPiAiRequestHeaders(request, headers, next) {
  try {
    const sessionId = request?.sessionId
    if (typeof sessionId === 'string' && sessionId.length > 0 && headers && typeof headers.set === 'function') {
      headers.set(HEADER_NAME, sessionId)
    }
  } catch {
    // Constraint 1: swallow EVERYTHING our own code can cause. Observer
    // contributes nothing; the call proceeds exactly as if we were absent.
  }
  // The chain must continue: a waterfall listener that does not call next()
  // vetoes the rest of the chain, including the host's inner callback.
  if (typeof next === 'function') return next()
  return headers // host shape mismatch: degrade to "contributed nothing"
}

export default apply
