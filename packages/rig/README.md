# @observer/rig — the differential fidelity harness

The verification spine of milestone 1. Every later acceptance criterion that says
"byte-identical", "including chunk boundaries", "within ±5 ms", or "on every
fixture" is judged by this package. If the rig is wrong, every green checkmark
downstream of it is wrong, so it is built to be verifiable itself.

## What it does

For each fixture, the rig runs the same request bytes twice:

```
baseline:  raw client ──────────────────────────► mock upstream (scripted)
SUT run:   raw client ──► system-under-test ────► mock upstream (same script)
```

…and diffs **everything fidelity means**:

| Axis | What is compared |
|---|---|
| response status | code **and reason phrase**, strictly |
| response headers | ordered (name, value) pairs; ignore set = exactly the hop-by-hop family, nothing else |
| response body | sha256 verdict + diff **regions with offsets, lengths, hex/ascii excerpts** |
| upstream request body (V1/A1) | sha256 of what the upstream saw through the SUT vs what the client sent |
| upstream request headers/line | parsed, same policy |
| arrival count | coalescing (fewer, larger arrivals) and splitting (more, smaller) |
| arrival boundaries | per-event cumulative byte offsets |
| arrival gaps | vs the baseline run AND vs the script's nominal schedule (±tolerance) |
| TTFB | SUT-minus-baseline delta against a budget |
| truncation | framing completeness + exact truncation byte offset must match |

## Design rules (why it is built the way it is)

1. **Raw bytes are the comparison medium.** Client and mock upstream are raw `net`
   sockets; the response decoder consumes HTTP framing and emits *decoded body bytes
   per socket event*. Nothing on any comparison path parses JSON. A rig that parses
   before comparing cannot detect chunk coalescing, cannot detect a field its schema
   does not know (`reasoning_content` is absent from OpenAI's own `ChoiceDelta`), and
   cannot detect a re-serialisation that happens to round-trip.
2. **The ground-truth side contains zero frameworks.** No node:http on the upstream
   (it would normalise headers and re-frame bodies); one scripted write = one chunked
   frame = one TCP write, deadline-corrected delays, optional mid-frame splits,
   socket death at an exact body offset.
3. **Incremental everything.** Hashes update per arrival. The rig buffers bodies for
   diff regions *by design as a test harness* — production paths (gateway/capture)
   must not, and the incremental hash mirrors the constraint they live under
   (>10 MB bodies at 1M-token context).
4. **Zero network, zero runtime dependencies.** Loopback-only by construction;
   enforced by boundary tests (`test/boundary.test.ts`), not by convention.
5. **The rig verifies itself in both directions.** `ReferencePipe` (a byte-faithful
   test double) must produce **zero diffs on every fixture** (`test/conformance.test.ts`),
   and six *faulty* doubles — JSON-round-trip, typed-model projection, sloppy
   headers, coalescing, buffering, SSE-rewriting — must each be **caught on their
   target axis** (`test/detect.test.ts`). The coalescing/buffering doubles produce
   byte-identical final bodies: only the arrival-timeline comparison sees them.
   A rig that has never failed proves nothing; a rig that has never passed is noise.

⚠ `src/testdoubles/` contains **test doubles, not Observer production code**. The V1
gateway lives in `packages/gateway` and must pass this same rig by importing it
(`runFidelityCheck({ fixture, sut: gateway })`) — the doubles exist so the rig could
be proven before the gateway existed.

## Usage

```ts
import { loadCorpus, runFidelityCheck, formatReport, ReferencePipe } from '@observer/rig'

for (const fixture of await loadCorpus()) {
  const report = await runFidelityCheck({ fixture, sut: mySut })
  if (!report.passed) console.error(formatReport(report, { timelines: true }))
}
```

`Sut` is the integration seam: `{ name, start({ upstreamOrigin, upstreamPort }) →
{ port, stop() } }`. Anything that listens on loopback and proxies qualifies — the
V1 gateway, a future h2 transport (V4e), or a deliberately broken double.

For latency acceptance at statistic scale (V1/A7: p50/p99 over ≥1000 requests;
V4b's TTFB criterion), use `runLatencyBenchmark`: alternating paired runs
(direct, SUT, direct, …) so machine drift cancels per pair, warmup excluded,
nearest-rank percentiles, every pair protocol-sanity-checked (a body-sha
divergence mid-benchmark is an anomaly, because the latency of a mutated
response is not the measurement). `checkLatencyBudget` turns a result into
pass/fail violations; `formatLatencyResult` renders it for CI logs.

Fixture format, provenance classes and integrity model: `fixtures/README.md`.

## Known limits (stated, not hidden)

- HTTP/1.1 only. HTTP/2 comparison is V4e scope; the `Sut` seam is transport-agnostic,
  but client/upstream twins for h2 do not exist yet.
- Request bodies with `Transfer-Encoding: chunked` are rejected at fixture load
  (no request-side chunk decoder yet); no V0 fixture needs one. DSH sends
  content-length.
- Truncation is modelled as FIN-after-partial-bytes, not RST — deterministic byte
  offsets matter more than errno realism here. RST-mode fault injection is V4d scope.
- Default TTFB budget is 25 ms single-shot. V4b's "<5 ms vs direct" is a p50/p99
  statistic over many requests and belongs to V4b's own harness run — a single-shot
  5 ms bound on a shared CI runner would measure the runner, not the proxy. Gap
  tolerance keeps the spec's ±5 ms.
- Timing assertions need a quiet machine: the suite runs test files sequentially
  (`fileParallelism: false`) because parallel workers manufacture scheduler jitter.
