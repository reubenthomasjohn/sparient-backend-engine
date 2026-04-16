import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '../utils/logger';

// Ensure sslmode=verify-full to silence the pg v8 deprecation warning about
// 'require' being treated as 'verify-full' (which is what we want anyway).
const dbUrl = new URL(process.env.DATABASE_URL!);
dbUrl.searchParams.set('sslmode', 'verify-full');

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
