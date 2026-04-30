import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';

// Vitest globalSetup hook: spin up one Postgres container for the whole run,
// run Prisma migrations against it, expose DATABASE_URL via env to test files.
// Container is torn down at the end.

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sparient_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  // prisma migrate deploy is idempotent and does not require a shadow DB.
  // It applies every migration in order — same path used in CI.
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}

export async function teardown(): Promise<void> {
  if (container) await container.stop();
}
