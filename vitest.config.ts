import { defineConfig } from 'vitest/config';

// Point Prisma at the integration test database BEFORE any test file imports
// db/client.ts. `?sslmode=disable` keeps the connection happy against the
// docker-compose Postgres which doesn't run with SSL.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://sparient:sparient@localhost:5432/sparient_test?sslmode=disable';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-each.ts'],
    testTimeout: 20000,
    hookTimeout: 60000,
    // The TRUNCATE in beforeEach (setup-each.ts) wipes the shared test DB,
    // so test files MUST run sequentially — otherwise file B's TRUNCATE deletes
    // file A's just-inserted fixtures mid-test and Prisma raises FK violations.
    fileParallelism: false,
  },
  // Single fork process for the same reason — multiple workers would each
  // truncate independently and stomp on each other.
  pool: 'forks',
  forks: { singleFork: true },
});
