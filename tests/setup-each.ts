import { beforeEach, afterAll } from 'vitest';
import prisma from '../src/db/client';

// Tables that participate in the remediation flow. Ordered so that referencing
// rows are truncated before referenced rows (FK-safe even without CASCADE).
const TABLES_IN_FK_ORDER = [
  'file_issue_categories',
  'batch_responses',
  'batch_files',
  'batches',
  'source_files',
  'courses',
  'institutions',
];

beforeEach(async () => {
  // CASCADE wipes dependent rows in a single statement and is much faster than
  // per-table deletes. RESTART IDENTITY is a no-op for UUID PKs but harmless.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES_IN_FK_ORDER.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
