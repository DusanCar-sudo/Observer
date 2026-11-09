/**
 * Type declarations for the session-id plugin (the plugin itself stays plain JS:
 * it is installed into a DSH profile without a build step).
 */

export declare const HEADER_NAME: 'X-Observer-Session'
export declare const WATERFALL_EVENT: 'llm-pi-ai/request-headers'

/** Cordis plugin entry: registers the waterfall listener; never throws. */
export declare function apply(ctx: unknown): void

/**
 * The waterfall listener. Contract (see plugin header comment):
 * - our own code never throws — any failure degrades to "contributed nothing";
 * - `next()` is always invoked when callable, and its return value is returned;
 * - a throwing `next()` propagates (downstream contributor faults are not ours
 *   to swallow — the host contract fails the call with REQUEST_HEADERS).
 */
export declare function onPiAiRequestHeaders(request: unknown, headers: unknown, next?: unknown): unknown

declare const _default: typeof apply
export default _default
