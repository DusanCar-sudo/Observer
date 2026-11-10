import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Skeleton state: remove once the rig's own test suite has landed (a package whose
    // `vitest run` finds no tests exits non-zero and would red-flag `pnpm -r test`).
    passWithNoTests: true,
    // Timing fidelity is an acceptance criterion of the rig itself (inter-chunk gap
    // assertions). Running test files in parallel would let CPU contention manufacture
    // scheduler jitter and flake those assertions, so the suite runs one file at a time.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
