import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '../utils/logger';

// Upgrade 'require' to 'verify-full' to silence the pg v8 deprecation warning
// (which treats 'require' as 'verify-full' anyway). Respect any other explicit
// sslmode — notably 'disable' for local dev / integration tests against the
// docker-compose Postgres, which doesn't run with SSL.
const dbUrl = new URL(process.env.DATABASE_URL!);
const currentSslmode = dbUrl.searchParams.get('sslmode');
if (currentSslmode === null || currentSslmode === 'require') {
  dbUrl.searchParams.set('sslmode', 'verify-full');
}

const adapter = new PrismaPg({
  connectionString: dbUrl.toString(),
});

const prisma = new PrismaClient({
  adapter,
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

prisma.$on('warn', (e) => logger.warn('Prisma warning', { message: e.message }));
prisma.$on('error', (e) => logger.error('Prisma error', { message: e.message }));

export default prisma;
