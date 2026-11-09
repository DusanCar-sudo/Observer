import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Skeleton state: the conformance suite (aura) has not landed yet, and a package
    // whose `vitest run` finds no tests exits non-zero, which would red-flag the root
    // `pnpm -r test` on every commit. Remove `passWithNoTests` once real tests exist —
    // after that, "no tests found" should fail loudly again.
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
