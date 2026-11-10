# @observer/capture — the V0a raw-byte logging tap

Records live DSH→qwen traffic **verbatim** so byte-fidelity acceptance criteria
(V1 A1–A5, V4a–V4e, V10) can be tested against real wire bytes instead of
reconstructions. DSH's session log carries no request bodies (lead's measurement,
spec §8), so this tap is the only source of `provenance: captured` fixtures.

## Fidelity contract (why this package exists in its exact shape)

- **Raw bytes are truth.** Nothing on the forwarding path parses a body.
  `reasoning_content` is absent from OpenAI's own `ChoiceDelta` schema
  (protocol-fidelity §4A.1): a typed tap would silently delete 100% of reasoning
  on target one, and every fixture captured through it would be wrong in a way no
  test could catch. The only parsing here is byte-level framing *observation*
  (to know when a response ended) and metadata for the index.
- **The single allowed mutation** is a byte-splice of the `Host` header value
  when forwarding to the real provider (providers reject foreign Host). Both the
  as-received and the forwarded head are recorded, so the splice is auditable —
  and a test proves it touches *exactly* the Host value bytes. `rewriteHost:false`
  (used in rig conformance) makes the tap byte-perfect end to end.
- **Compression is stored as received** (spec §8): gzip/br bodies are never
  decompressed on the wire path; decompressing a copy for inspection is a
  separate, lossless, derived step.
- **Truncation is propagated as truncation.** Upstream death mid-stream reaches
  the client as the same partial bytes with no fabricated terminator, and the
  capture is marked `incomplete:*` — never `complete`. Client aborts propagate
  upstream. No capture may claim a terminal event it did not observe.
- **Recording never stalls traffic (I1).** Capture is streamed to disk with
  incremental sha256; finalization is write-behind (meta.json lands after the
  exchange, never before the client's bytes). A recorder failure loses the
  record, never the request.
- **Zero mutation is MEASURED, not asserted:** `test/tap-fidelity.test.ts` runs
  the tap as a system-under-test through `@observer/rig`'s differential harness
  over the entire fixture corpus — status, headers, body bytes with offsets,
  upstream-request bytes, arrival counts/boundaries/gaps, TTFB, truncation
  offsets — and requires zero diffs.

## Store layout (append-only; V2 formalises it)

```
<outDir>/                              default ./observer-data/captures (gitignored)
  captures.jsonl                       append-only index, one line per capture
  <capture-id>/
    request.head.bin                   raw head bytes AS RECEIVED from the client
    request.forwarded-head.bin         raw head as forwarded (only when spliced)
    request.body.bin                   raw body bytes as received (streamed)
    response.wire.bin                  raw response wire bytes: status line +
                                       headers + chunk framing + body, exactly
                                       as they arrived from the provider
    meta.json                          written LAST (its presence = finalized):
                                       status, sha256s, arrival timelines for both
                                       directions, upstream origin, error if any
```

Capture ids are collision-resistant (timestamp + pid + random + counter, plus an
existence guard) — two recorders sharing one outDir can never silently overwrite
each other. A directory without `meta.json` was interrupted: treat as suspect,
never as valid.

The raw store is NEVER redacted in place (I2). `redactCapture()` produces derived
copies with credential-shaped content scrubbed (headers by name; bodies by
pattern: provider keys, bearer tokens, AWS/GitHub/Slack shapes, JWTs, PEM keys).
Redacted copies declare `redacted: true` and their hashes differ by design.

## Running a live capture (requires a config change by the Human/lead — the
## dev sandbox treats ~/.dsh as read-only)

```bash
pnpm --filter @observer/capture build
node packages/capture/bin/tap.mjs \
  --listen-port 8787 \
  --upstream https://token-plan.ap-southeast-1.maas.aliyuncs.com \
  --out ./observer-data/captures
```

Then in DSH settings:

```yaml
llm-pi-ai:
  providers:
    <qwen-route>:
      baseURL: "http://127.0.0.1:8787/compatible-mode/v1"
```

**The config change does NOT redirect an already-running session.** A docstring
in `dsh-llm-pi-ai` suggests profiles are re-read per operation, but lead's live
experiment (2026-11-10, task-17 pre-flight) falsified it for `baseURL`: a real
DSH inference inside the window never reached the tap. Mechanism unverified
(likely a cached provider client or connection pool), the operational fact is
verified: **restart DSH, or start a brand-new session after the change**, and
VERIFY SUCCESS BY OBSERVING A CAPTURE APPEAR — absence of captures is not
evidence the tap is broken, and a config change on disk is not evidence traffic
moved.

Run the agent session, then restore the original `baseURL`. The tap forwards the
request target verbatim, so keep the upstream path suffix the provider expects
(the default qwen route's suffix is `/compatible-mode/v1`; `--upstream` takes the
origin only). `OBSERVER_TAP_DEBUG=1` traces exchanges to stderr.

## Acceptance status (task-2 / V0a)

| Criterion | Status |
|---|---|
| Recorded bytes sha256-stable across capture/replay round trip | **MET** — `test/tap-roundtrip.test.ts`: capture → `startReplayServer` → re-capture, wire sha256 identical |
| gzip/br stored compressed as received | **MET** — gzip fixture: magic bytes + payload equality asserted on stored wire |
| Zero mutation of traffic | **MET** — full-corpus differential conformance (full-corpus) |
| Redaction pass before commit | **MET** — `redactCapture()` + tests; raw store untouched |
| Captures a full REAL DSH→qwen session (streaming, tool calls, reasoning) | **BLOCKED ON A LIVE RUN** — needs the Human/lead to point DSH at the tap (config change outside my sandbox) and run a session. Everything else is ready; the runbook is above. |
| ≥20-fixture set from live traffic, or documented unobtainables | Unobtainables **DOCUMENTED BELOW**; the export tool (`tools/captures-to-fixtures.mjs`) is **BUILT AND TESTED END TO END** on synthetic captures (capture → convert → rig-load → ReferencePipe conformance, zero diffs) — the live run just feeds it real bytes |

### Which V0 fixture categories live traffic can and cannot produce

Obtainable from real DSH→qwen sessions (expected): the 40-tool request; streaming
responses with `reasoning_content`; parallel tool calls; non-streaming responses;
`[DONE]` termination; `usage` final-chunk behaviour; large bodies; retry pairs
(`llm/retry` occurs 99× across the corpus — retries are the normal case).

**Not** reliably obtainable live, must stay synthetic (fixture-shaped by hand):
4xx/5xx error bodies (providers don't fail on schedule; 429s only under real rate
limits); non-JSON 5xx bodies (infrastructure-dependent); mid-chunk aborts and
interrupted streams (network-dependent); mid-frame TCP splits and multi-byte
splits (server buffering-dependent); `obfuscation` chunks (an OpenAI-side field —
whether qwen emits it at all is unverified); gzip-encoded responses (qwen's
encoding choice per response, not requestable on demand). The synthetic corpus
(`fixtures/corpus/`, provenance-labelled) remains the coverage backbone; captured
fixtures get layered on top with `provenance: captured` and the same manifest
integrity discipline.

## Known simplifications (V0a, deliberate, documented)

- Fresh upstream connection per request (no pooling): one extra handshake per
  request, in exchange for zero framing/reuse state in the capture path.
- HTTP pipelining (next request before the current response completes) is refused
  with a recorded `refused` status rather than guessed at; undici does not
  pipeline by default. Late keep-alive bytes arriving during write-behind
  finalization ARE handled (requeued for the next exchange) — that race is real
  and was caught by test.
- Chunked REQUEST bodies refused with a loud 501 + recorded reason (DSH sends
  content-length on chat completions).
- TLS path (`https:` upstream) is exercised in the live run, not in unit tests —
  tests cover the `http:` transport against the rig's mock upstream. Flagged as
  [unverified until first live capture] per the standard of evidence.
