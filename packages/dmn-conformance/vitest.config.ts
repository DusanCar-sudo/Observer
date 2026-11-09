import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `passWithNoTests` removed 2026-11-09 (aura): test/conformance.test.mjs has landed, so
    // "no tests found" must fail loudly again — a silently-skipped conformance suite would
    // defeat the whole purpose of pinning the engine versions.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
