import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { logger } from '../../utils/logger';

// Runs `prisma migrate deploy` from inside the VPC, where the private RDS Proxy is
// reachable (the GitHub-hosted runner can't reach it). Invoked on demand by CI via
// `aws lambda invoke` after `terraform apply`. Returns { ok, output } so the caller
// can assert success from the response payload.
//
// The image (Dockerfile.migrate) keeps the full node_modules + prisma/ + prisma.config.ts,
// so this mirrors the proven `npx prisma migrate deploy` path used locally and in CI.
// DATABASE_URL (proxy endpoint, sslmode=verify-full) is supplied as a Lambda env var, and
// prisma.config.ts wires it into the datasource via env('DATABASE_URL').
export async function handler(): Promise<{ ok: boolean; output: string }> {
  const root = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
  const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');

  const output = execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  logger.info('Migrations applied', { output });
  return { ok: true, output };
}
