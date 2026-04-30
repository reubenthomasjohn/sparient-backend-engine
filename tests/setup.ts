// Stub env vars before any service module loads — config does process.exit(1)
// on missing DATABASE_URL, which would crash the whole test process.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.AWS_REGION ??= 'us-east-2';

import { beforeEach, vi } from 'vitest';
import { mockDeep, mockReset } from 'vitest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Single deep-mocked PrismaClient shared by every test. Each test resets it.
// Services import `prisma from '../../db/client'` — the vi.mock below replaces
// that default export with this mock.
export const prismaMock = mockDeep<PrismaClient>();

vi.mock('../src/db/client', () => ({
  __esModule: true,
  default: prismaMock,
}));

// Quiet logger output during tests. Tests that want to assert on log calls can
// re-mock with vi.mocked(logger.info).mockImplementation(...).
vi.mock('../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    http: vi.fn(),
  },
}));

beforeEach(() => {
  mockReset(prismaMock);
  // $transaction passes the mocked client into the callback so writes inside
  // a tx use the same mock as writes outside.
  prismaMock.$transaction.mockImplementation((arg) => {
    if (typeof arg === 'function') return arg(prismaMock);
    // Array form: just resolve all
    return Promise.all(arg as Promise<unknown>[]);
  });
});
