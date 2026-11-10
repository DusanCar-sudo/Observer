import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The A7 latency acceptance (p50/p99 over >=1000 paired requests) and the
    // rig-conformance timing axes need a quiet machine: one file at a time.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
})
