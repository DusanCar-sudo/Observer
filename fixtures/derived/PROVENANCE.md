# Provenance — fixtures/derived

## dsh-qwen-40-tools.header.json

**What it is:** the verbatim `request/header.data.header` object from a real DeepSeek
Harness (DSH) session on this machine — `{config: {provider: "qwen", model:
"qwen3.8-max"}, tools: [40 tool schemas]}`. 47,821 bytes.

**Why it is here:** the V0 acceptance criteria require a fixture with a 40-tool
request. Byte-exact *request bodies* cannot be obtained until the V0a logging tap
exists (lead's measurement: the session log carries no `messages` array — see
`docs/spec/vertical-slice-tasks.md` §8). The `tools` array, however, IS logged, so
the tool half of a real DSH→qwen request is real; the surrounding request body built
from it is synthetic. Fixtures derived from this file carry `provenance: "derived"`.

**Source (read-only; nothing under `~/.dsh` was modified):**

- Session file: `~/.dsh/sessions/--mnt-bigdata-projects-Observer--/f1376d54-378a-4377-945f-1aad150d9f0b/session.v4.jsonl.zstd`
- Extracted: 2026-11-09 (Asia/Saigon), DSH session format v4 per `docs/recon/dsh-session-format.md`
- Reproduce: `node tools/extract-dsh-header.mjs <session.v4.jsonl.zstd> <out.json>`

**Sensitivity scan performed before committing (2026-11-09):** grep for
`/home/<user>`, `/mnt/…` paths, e-mail shapes, `sk-…`-shaped keys, and
`api[_-]?key` over the extracted file returned **zero matches**. The content is DSH's
own generic tool-definitions (names, descriptions, JSON-schema parameters) — product
surface of the harness, not user data. If a future re-extraction ever produces
matches, the derived fixture must be sanitised before commit and the sanitisation
recorded here.

**Integrity:** sha256 recorded in `fixtures/corpus/manifest.json` (via the fixtures
built from it) and re-verifiable with `shasum -a 256 dsh-qwen-40-tools.header.json`.
