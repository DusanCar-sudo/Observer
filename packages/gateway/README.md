# @observer/gateway — V1 byte-faithful pass-through

The MITM gateway for milestone 1: `POST /v1/chat/completions` only (DSH→qwen as
deployed), forwarding raw bytes in both directions, recording everything,
refusing explicitly what is not supported, and **mutating nothing** (P3). The
prefix-edit gate lives here: on target one a serialization sin produces NO
provider-side error — only silent cache loss and corrupted reasoning — so this
package's test suite is the only detection that exists (spec §3).

## Architecture

The byte-faithful pipeline lives **once**, in `@observer/capture`'s
`proxy-core` (spec §1: two components that both "guarantee" fidelity produce a
guarantee nobody tests). The V0a tap and this gateway are thin policy layers
over the same judged core:

| Concern | Owner |
|---|---|
| keep-alive exchange sequencing, §9.4 finalize race, truncation propagation, backpressure, Host splice, hop-by-hop excision | `@observer/capture` proxy-core |
| routing/refusals (A8), statistics (§9.1), capture policy, fail-open wiring (A6) | this package |

The gateway adds exactly one core flag: `stripRequestHopByHop: true` (A4). The
tap keeps forwarding heads untouched (its accepted V0a contract).

**There is no JSON parser or serializer anywhere in `src/`** — enforced by a
source-scanning test (`a2-serializer-sins.test.ts`). Refusal bodies are static
string constants. If you need to understand a body, parse a COPY (V3's rule)
and never re-serialise onto the wire.

## Acceptance criteria → tests

| Criterion | Test file | What is asserted |
|---|---|---|
| A1 upstream body byte-identity | `a1-upstream-byte-identity.test.ts` | full-corpus rig conformance, zero diffs; upstream-saw sha == client-sent sha on **every** fixture (list loaded dynamically — new fixtures are covered automatically) |
| A2 three serializer sins | `a2-serializer-sins.test.ts` | named byte-level tests: unknown fields (`reasoning_content`, `x_custom`), empty fields (`""`/`null`/`[]`), number/escape spellings (`1.0`, `0.900`, `1e3`, `\u00e9`, `\/`); plus the no-JSON-codec source scan |
| A3 response identity | covered by A1 conformance | status/reason/headers/body-bytes axes, zero diffs |
| A4 header hygiene | `a4-header-hygiene.test.ts` | hop-by-hop excised at byte level, everything else verbatim in order; response headers untouched (nothing added — no `x-powered-by` class leaks); `retry-after` preserved |
| A5 errors pass through | `a5-errors.test.ts` | 429/400/502(non-JSON) byte-identical; upstream connect failure → 502 with `x-observer-gateway` marker, text/plain, counted, recorded — never a provider-shaped JSON 500 |
| A6 fail-open (I1) | `a6-fail-open.test.ts` | poisoned recorder (dead on arrival AND dying mid-response): traffic stays zero-diff under the rig, failures COUNTED, no hangs |
| A7 latency | `a7-latency.test.ts` | 1000 paired requests (2050 total runs) via the bench harness: total-latency delta p50 < 15 ms, p99 < 40 ms, zero protocol anomalies (§9.2: a mutated response invalidates the measurement) |
| A8 refusals (corrected, §9.1) | `a8-refusals.test.ts` | path + `anthropic-version` header refusals only; `/v1/responses` → 501 `unsupported-protocol`; refusals captured (`status: refused`) and counted; large refused bodies drained (client reliably receives the 501); `refuseOnBodyShape: true` FAILS STARTUP in milestone 1 — the gateway refuses to pretend at enforcement it cannot perform |
| §9.4 named race | `keepalive-finalize-race.test.ts` | next-request bytes during write-behind finalization are requeued, never misread as pipelining |
| §9.1 counted & visible | `stats-visibility.test.ts` | snapshot isolation; `misdialectVerdicts` slot live at zero from day one; V3 feed hook ready |
| V4a socket-byte identity | `v4a-stream-byte-identity.test.ts` | per-arrival byte-length/cum-offset identity vs baseline on every streaming shape (splits incl. mid-UTF-8-character, 151-event scale, truncation offsets); ORDERING tests: truncation/abort counters consistent before the client can observe the close; recording↔delivery agreement |
| V4b timing fidelity | `v4b-timing-fidelity.test.ts` + `bench/` | four-arm interleaved TTFB gates (A: capture-off p99 ≤ same-session ReferencePipe p99; B: capture cost p50 ≤ 1.5 ms derived, retires at V2 ≤0.3 ms; shipping p50 < 5 ms absolute) + per-chunk `arrival−emit` ≤ 5 ms hard over 25 fresh-process runs of the 50 ms cadence fixture; all distributions printed every run |
| V4c framing edge cases | `v4c-framing.test.ts` | event split across TCP writes AND chunked frames; `[DONE]` exactly once, never parsed (structural: no JSON codec exists); `obfuscation` named regression + teeth-proof via SseRewritingPipe; gzip/br untouched (§8); corpus-wide non-injection sweep (no keepalive comments — lead constraint) |

## Events and stats

Every lifecycle transition emits a `ProxyEvent` (exchange-start, forwarded,
refused+reason, response-complete/truncated, client-aborted,
upstream-connect-failed, capture-error). `stats()` exposes the accumulated
counters; the CLI prints them periodically. Event emission is ordered
**before** capture persistence so counters are consistent with what a client
can already observe (a race the A5 test caught: emitting after the finalize
await let a fast client close outrun its own error's counter).

A8's body-shape layer is SOFT in milestone 1 by design: V3's permissive parse of
a copy will feed `noteMisdialectVerdict()`, visible on the dashboard (V9). A
nonzero count during ordinary DSH→qwen operation means **our** dialect
assumption is wrong somewhere — a finding about Observer, not about traffic.

## Running

```bash
pnpm --filter @observer/gateway build
node packages/gateway/bin/gateway.mjs --listen-port 8788 \
  --upstream https://token-plan.ap-southeast-1.maas.aliyuncs.com
# DSH settings (reversible — I4; requires DSH RESTART or a NEW session: the
# baseURL change does not redirect an already-running session — falsified live
# 2026-11-10; verify by watching captures/stats appear):
#   llm-pi-ai.providers.<qwen-route>.baseURL: "http://127.0.0.1:8788/compatible-mode/v1"
```

## Known limits (stated, not hidden)

- HTTP/1.1 only; HTTP/2 is V4e (the rig's `Sut` seam is transport-agnostic, but
  h2 client/upstream twins do not exist yet).
- Streaming: V4a (socket-byte identity) and V4c (framing edge cases) suites live
  in this package and are green, including under induced CPU load (8 burners on
  16 cores: v4c 9/9, a1 31/31). V4d (fault-injection matrix) and V4e (transport
  matrix, slow-store backpressure) remain.
- No upstream connection pooling (fresh connection per request; documented in
  proxy-core). Loopback-measured A7 is unaffected; the live TLS run (task-17)
  will measure the handshake cost before pooling is decided — V4e territory.
- Session identity (V6), capture store formalisation (V2), normalisation (V3):
  downstream tasks. The gateway currently records the `X-Observer-Session`
  header if a client sends one, and does nothing with it yet.
