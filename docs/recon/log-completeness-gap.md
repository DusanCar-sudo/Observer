# Recon: the session log is not a complete record of filesystem mutations

**Author:** `lead`
**Date:** 2026-11-10
**Status:** OBSERVED, cause UNKNOWN. Every claim below is from session logs and filesystem mtimes
read directly. The explanation is not established and is explicitly not guessed at.
**Severity:** first-order for the grounding pillar. This is a blind spot in Observer's primary
evidence source.

---

## 1. What was observed

At 08:26 local on 2026-11-10, `forge` reported uncommitted changes in `packages/capture/` that it
did not believe it had written: `tap.ts` rewritten as a thin wrapper over a new `proxy-core.ts`,
`index.ts` re-exporting the core's types, a `HeaderPairs` type added to `types.ts`, and a new
`test/proxy-core-policy.test.ts`. It asked for a provenance check before committing.

Filesystem mtimes:

| File | mtime (local) |
|---|---|
| `packages/capture/src/types.ts` | 08:21:24 |
| `packages/capture/src/tap.ts` | 08:22:03 |
| `packages/capture/src/index.ts` | 08:22:24 |
| `packages/capture/test/proxy-core-policy.test.ts` | 08:24:32 |
| `packages/capture/src/proxy-core.ts` | 08:25:52 |

Session logs were then read directly with the project's own watcher tooling.

## 2. What the logs show

Only **two** session files under `~/.dsh` were modified in the preceding three hours — `forge`'s
(`f1376d54…`) and `lead`'s (`session-85ce1928…`). There are no per-profile session stores.

**`lead`'s session**, complete tool-call record 08:15–08:35: edits to `packages/cli/src/scan.ts`,
`.github/workflows/ci.yml`, `README.md`, and `packages/{watcher,detectors,cli}/package.json` plus
`tsconfig.json`; the rest are `bash` calls (builds, tests, `git show`, `git add`/`commit`, `gh run
list`) and the provenance investigation itself. **No call touches `packages/capture`.**

**`forge`'s session**, 24 tool calls in the same window, sequence numbers **contiguous from seq
1637 to seq 1681 with no gaps** — so the log is complete for this period and this is not a flush or
buffering artefact:

| Time | seq | Call |
|---|---|---|
| 08:15:28–08:15:55 | — | 7 × `edit` on `packages/capture/src/recorder.ts` |
| 08:20:32 | 1638 | `write` `proxy-core.ts` (31,876 B) |
| 08:22:32 | 1644, 1646, 1648 | 3 × `edit` on `proxy-core.ts` |
| 08:23:00 | 1655 | `bash` — `git log` / `git status` (read-only) |
| 08:23:45 | 1662 | `bash` — `git diff` on the "unexpected modifications" (read-only) |
| 08:24:43 | 1669 | `bash` — `cat` tap.ts and the policy test (read-only) |
| 08:25:15 | 1676 | `bash` — build + test |
| 08:26:36 | — | `send_message` (the provenance question) + `packages/gateway` scaffolding |

**There is no `write` or `edit` tool call in either log at 08:21:24, 08:22:03, 08:22:24, or
08:24:32.** Four files were modified and no session recorded doing it.

Note that `proxy-core.ts` — written at 08:20:32 and edited at 08:22:32 — *is* recorded, and its
mtime (08:25:52) is later than the last logged edit, so at least one further unrecorded touch
occurred there as well.

## 3. What is NOT known

The cause is unestablished. Candidates not investigated: a harness code path that writes without
emitting a `tool/call` record; an external editor or formatter; a build step; something in the
desktop app. **No candidate is asserted here**, because asserting one would be exactly the error
this document exists to warn against. What is established is narrower and still sufficient:

> **The absence of a `tool/call` record does not establish that no mutation occurred.**

## 4. Consequences for Observer

### 4.1 Silence is not absence

This is the same asymmetry already adopted for invariant I1 in T12: *fail open means "do not
mutate", it must never mean "assume the claim was grounded."* The ledger analogue:

> **A missing record must never be read as evidence that an event did not happen.**

Two failure directions follow, and they are not equally survivable:

- A true claim gets marked `unverified` because its supporting event was never logged. Annoying,
  visible, and survivable — this is the conservative direction and I5 prefers it.
- The ledger's *completeness* assumption is used to conclude that an agent fabricated evidence,
  when in fact the evidence exists and simply was not recorded. **This is an accusation built on
  silence, and it is the failure that ends a supervisor's deployment.** T13(i) identified the same
  shape for cross-session evidence; this is the same problem arriving from the log itself.

### 4.2 V7 needs a provenance-of-absence distinction

The Evidence Ledger must distinguish, as separate and non-collapsible states:

1. **Witnessed** — a record exists and was parsed.
2. **Not witnessed** — no record exists. *No inference permitted.*
3. **Witnessed absent** — a record positively establishes non-occurrence (rare; requires the log to
   be known-complete for the interval, which §2 shows cannot be assumed in general).

Only (3) may support a `contradicted` verdict. Most current reasoning implicitly treats (2) as (3),
and §2 is a concrete demonstration that the two come apart.

Practical corollary: a `contradicted` verdict based on ledger absence requires a **completeness
argument for the interval**, and where the source is a harness session log, that argument is
currently unavailable. Until it is, absence-based contradictions should be reported as
`unverified` with the reason recorded.

### 4.3 It strengthens the gateway relative to the watcher

The gateway sees the actual bytes on the wire and does not depend on the supervised harness having
logged its own behaviour honestly or completely. The watcher is cheaper, needs no cooperation, and
works on agents that cannot be rerouted — but it **permanently inherits this blind spot**, because
it is downstream of whatever the harness chose to record.

This does not reverse decision D1 (both surfaces are still wanted). It does mean:

- Grounding verdicts that depend on *absence* should be attributed to the surface that produced
  them, and the watcher's absence claims carry weaker standing than the gateway's.
- The dashboard should say which surface a finding came from. "No record of that command" means
  something different depending on whether Observer was on the wire or reading a log.

### 4.4 An unplanned validation

The investigation that produced this document was carried out **with Observer's own watcher**
(`packages/watcher` + a 40-line throwaway query script), reading real session logs, to resolve a
real provenance dispute between two agents. That is the product's intended use, exercised for the
first time on a genuine question rather than a synthetic one — and it produced a finding about the
product's own foundations. The watcher adapter for DSH works; the assumption underneath it does not.

## 5. Reproduce

```bash
# Which sessions were active?
find ~/.dsh -name '*.jsonl.zstd' -mmin -180 -printf '%TH:%TM  %p\n' | sort

# Every tool call in a window, for one session:
zstd -dc ~/.dsh/sessions/<slug>/<session-id>/session.v4.jsonl.zstd \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      for (const l of s.split("\n").filter(Boolean)) {
        const r = JSON.parse(l);
        if (r.type !== "tool/call") continue;
        console.log(new Date(r.time).toISOString(), r.seq, r.data.name,
          String(r.data.arguments).replace(/\s+/g," ").slice(0,120));
      }});'
```

Compare against `ls -la --time-style=+%H:%M:%S <files>` and look for mtimes with no corresponding
`write`/`edit` record. Contiguity of `seq` across the window is what makes the log's completeness
checkable; without it, a gap and an unrecorded write are indistinguishable.
