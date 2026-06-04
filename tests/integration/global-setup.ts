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

  // Append sslmode=disable: the testcontainer Postgres image has no SSL, and
  // src/db/client.ts defaults to verify-full when sslmode is unset.
  const baseUrl = container.getConnectionUri();
  const url = new URL(baseUrl);
  url.searchParams.set('sslmode', 'disable');
  process.env.DATABASE_URL = url.toString();

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
