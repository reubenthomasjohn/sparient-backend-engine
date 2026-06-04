import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Pure unit suite — no DB, no network. Anything that needs a real Postgres
    // belongs in tests/integration (not yet wired up).
    environment: 'node',
    clearMocks: true,
  },
});
