import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['./tests/integration/global-setup.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    environment: 'node',
    // Postgres + migrations cold-start is slow; testcontainers handles container reuse,
    // but the first invocation can take ~10s on a clean machine.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each integration test resets DB state in beforeEach. Running them sequentially
    // avoids cross-test races on shared schema state.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
