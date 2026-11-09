# Fixture corpus

The evidence base for every "verified on every fixture" acceptance criterion in
`docs/spec/vertical-slice-tasks.md`. **A fixture that silently rots is worse than no
fixture**, so everything here is hash-pinned and machine-checked.

## Layout

```
fixtures/
  derived/                  real artifacts extracted from live systems (see PROVENANCE.md)
  corpus/
    manifest.json           sha256 + byte length for every file; generator pins
    <fixture-id>/
      fixture.json          metadata, request headers, response script (payloads inline)
      request.bin           request body bytes (only when > 4 KiB; small bodies are inline)
      response.gzip.bin     binary response payloads (only the gzip fixture)
```

## Provenance classes (declared per fixture, enforced by the loader)

| Class | Meaning |
|---|---|
| `synthetic` | Hand-authored bytes shaped like real DSH→qwen traffic. |
| `derived` | Built partly from real logged artifacts (e.g. the verbatim 40-tool `request/header` from a real DSH session — see `derived/PROVENANCE.md`). |
| `generated` | Produced by a deterministic seeded generator; sha256 pinned in the manifest (the >5 MB body — kept out of git on purpose). |
| `captured` | **Reserved.** Byte-exact recordings of live traffic via the V0a tap. Nothing may claim this class until V0a exists — a reconstruction cannot test byte identity, that is the whole point. |

## Integrity model

- `manifest.json` records sha256 + length for every committed file. The rig's loader
  (`packages/rig/src/fixtures.ts`) re-verifies **every hash at load time** and refuses
  to run a fixture that does not match — corruption fails loudly, at load, by name.
- Generated payloads are re-derived and hash-checked on every load, which doubles as
  a cross-platform determinism check (local, CI, any arch) on every test run.
- `node tools/build-fixtures.mjs --check` (wired into CI) additionally asserts the
  on-disk corpus still matches the builder's output, so a hand-edited fixture fails
  the build instead of quietly testing something nobody designed.

## Regenerating

```bash
pnpm --filter @observer/rig build     # builder imports dist/generators.js
node tools/build-fixtures.mjs         # full rebuild (deterministic; gzip bytes are
                                      # zlib-version dependent — review the diff)
node tools/build-fixtures.mjs --check # verify only
```

## Budget note (spec §3)

Real qwen traffic at 1M-token context produces multi-megabyte bodies. This corpus
keeps git small on purpose: the >5 MB fixture is generated, not stored. When V0a
starts capturing real traffic, the **full corpus lives outside git** (a fixture
store, same sha-pinning discipline); only a reviewed, redacted subset gets checked
in here — captures contain real file paths and content from the Human's sessions.

## Coverage

The task-1 acceptance categories (`req:40-tools`, `res:stream-reasoning-content`,
`res:stream-parallel-tools`, `res:nonstream`, `res:4xx-json`, `res:5xx-nonjson`,
`res:stream-obfuscation`, `req:body-over-5mb`, `res:stream-abort-mid-chunk`,
`res:stream-done`) are asserted as executable tag checks in
`packages/rig/test/fixtures.test.ts` — the corpus cannot silently shrink below them.
