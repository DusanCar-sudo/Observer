import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Timing-sensitive fidelity tests (the tap is judged by the rig): one file at a time.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
