import { execSync } from 'node:child_process';
import { Client } from 'pg';

// Vitest globalSetup: runs once before any test process spawns. Ensures the
// test database exists and is at the latest migration. Idempotent — safe to
// re-run.
export default async function setup(): Promise<void> {
  const testUrl = new URL(process.env.DATABASE_URL!);
  const dbName = testUrl.pathname.replace(/^\//, '');

  // Connect to the default 'postgres' database to issue CREATE DATABASE.
  const adminUrl = new URL(testUrl.toString());
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (rows.length === 0) {
    // Identifier interpolation — dbName is from our own URL, no injection risk.
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  await admin.end();

  // Apply schema. `prisma migrate deploy` is idempotent and won't re-run already-
  // applied migrations.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
  });
}
