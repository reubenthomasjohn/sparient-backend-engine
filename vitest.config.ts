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
  },
  // Postgres is shared state; serial execution avoids cross-test interference.
  // In Vitest 4, pool config moved out of `test.*` to top level.
  pool: 'forks',
  forks: { singleFork: true },
});
