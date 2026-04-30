import { beforeEach, afterAll } from 'vitest';
import prisma from '../../src/db/client';

// Per-test reset: truncate tables in dependency order so each test starts clean.
// We can't use transactions to wrap a test because the BatchBuilder code uses
// $transaction internally, and Prisma 7 doesn't support nested savepoint
// transactions across that pattern reliably. Truncate is fast on tiny tables.
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "file_issue_categories" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "batch_files" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "batches" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "source_files" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "courses" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "institutions" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await prisma.$disconnect();
});
