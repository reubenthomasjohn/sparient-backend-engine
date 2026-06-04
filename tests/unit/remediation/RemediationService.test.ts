import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { prismaMock } from '../../setup';
import {
  makeBatch,
  makeBatchFile,
  makeSourceFile,
} from '../../fixtures';
import {
  RemediationService,
  parseRemediatedPath,
} from '../../../src/services/remediation/RemediationService';
import { writebackQueue } from '../../../src/queue';
import type { ConnectivoResultsPayload } from '../../../src/types/connectivo';

vi.mock('../../../src/queue', () => ({
  writebackQueue: { send: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(writebackQueue.send).mockReset();
  vi.mocked(writebackQueue.send).mockResolvedValue(undefined);
});

describe('parseRemediatedPath', () => {
  it.each([
    ['/bucket/connectivo-remediated/foo.pdf', { bucket: 'bucket', key: 'connectivo-remediated/foo.pdf' }],
    ['//bucket/connectivo-remediated/foo.pdf', { bucket: 'bucket', key: 'connectivo-remediated/foo.pdf' }],
    ['bucket/connectivo-remediated/foo.pdf', { bucket: 'bucket', key: 'connectivo-remediated/foo.pdf' }],
    ['/bucket/key.pdf', { bucket: 'bucket', key: 'key.pdf' }],
  ])('parses bucket + key: %s', (input, expected) => {
    expect(parseRemediatedPath(input)).toEqual(expected);
  });

  it.each([
    ['/bucket/'], // bucket but no key
    ['/bucket'],  // no separator after bucket
    ['bucket-only'],
    [''],
  ])('returns null for malformed input: %s', (input) => {
    expect(parseRemediatedPath(input)).toBeNull();
  });
});

function buildPayload(overrides: Partial<ConnectivoResultsPayload> = {}): ConnectivoResultsPayload {
  return {
    batch: {
      id: 'connectivo-batch-1',
      external_batch_id: 'batch-1',
      state: 'completed',
      started_at: '2026-04-01T00:00:00Z',
      completed_at: '2026-04-01T00:10:00Z',
      summary: {
        total_files: 1,
        total_pages: 10,
        succeeded: 1,
        failed: 0,
        requires_review: 0,
        skipped: 0,
        total_issues_found: 0,
        total_issues_fixed: 0,
      },
    },
    folders: [
      {
        path: '/bucket/connectivo-incoming/course-1/',
        files: [
          {
            file_name: 'doc.pdf',
            remediated_path: '/bucket/connectivo-remediated/course-1/cf-1.pdf',
            custom_fields: { file_id: 'sf-1', canvas_file_id: 'cf-1' },
            quality_label: 'Good',
            state: 'Completed',
            total_pages: 10,
            processing_time_seconds: 5,
            compliance_errors: 0,
            compliance_warnings: 0,
            total_issues_found: 0,
            total_issues_fixed: 0,
            issues_by_category: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// Stub the full tx call chain so handleResults runs without crashes. Caller can
// override individual mocks per-test (e.g. batchResponse.create rejecting with P2002).
function stubTransactionMocks(opts: { responseCount?: number } = {}): void {
  prismaMock.batchResponse.create.mockResolvedValue({} as any);
  prismaMock.batchResponse.count.mockResolvedValue(opts.responseCount ?? 1);
  prismaMock.batchFile.update.mockResolvedValue({} as any);
  prismaMock.batchFile.findMany.mockResolvedValue([]);
  prismaMock.batchFile.count.mockResolvedValue(0);
  prismaMock.fileIssueCategory.deleteMany.mockResolvedValue({} as any);
  prismaMock.fileIssueCategory.createMany.mockResolvedValue({} as any);
  prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 } as any);
  prismaMock.batch.update.mockResolvedValue({} as any);
  prismaMock.$queryRaw.mockResolvedValue([] as any);
}

// Shape that enqueueWritebacks's batch.findUnique expects.
function batchForEnqueue(opts: {
  institutionOptIn?: boolean;
  courseOptIn?: boolean | null;
  batchFiles: any[];
}) {
  return {
    ...makeBatch({ status: 'completed' }),
    institution: { writebackOptIn: opts.institutionOptIn ?? true },
    course: { writebackOptIn: opts.courseOptIn ?? null },
    batchFiles: opts.batchFiles,
  };
}

describe('RemediationService.handleResults', () => {
  const service = new RemediationService();

  it('throws when the batch does not exist', async () => {
    prismaMock.batch.findUnique.mockResolvedValue(null);
    await expect(
      service.handleResults('batch-x', buildPayload(), 'some-key.json'),
    ).rejects.toThrow();
  });

  it('calls enqueueWritebacks after a successful first-response commit', async () => {
    const sourceModifiedAt = new Date('2026-04-01');
    prismaMock.batch.findUnique
      // initial batch fetch in handleResults
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'pending' }),
        batchFiles: [
          { ...makeBatchFile({ sourceFileId: 'sf-1' }), sourceFile: makeSourceFile() },
        ],
      } as any)
      // post-tx enqueueWritebacks fetch — return an eligible file so the call
      // path through to writebackQueue.send is actually exercised.
      .mockResolvedValueOnce(
        batchForEnqueue({
          batchFiles: [
            {
              ...makeBatchFile({ id: 'bf-eligible', sourceModifiedAt }),
              sourceFile: {
                writebackState: null,
                lastWritebackModifiedAt: null,
                batchedModifiedAt: sourceModifiedAt,
              },
            },
          ],
        }) as any,
      );
    stubTransactionMocks({ responseCount: 1 });

    await service.handleResults('batch-1', buildPayload(), 'first-response.json');

    // The transaction ran (first-response branch).
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.batchResponse.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ s3Key: 'first-response.json' }),
      }),
    );
    // Normal-path enqueueWritebacks fired for the eligible file.
    expect(writebackQueue.send).toHaveBeenCalledWith({ batchFileId: 'bf-eligible' });
  });

  it('falls into the crash-recovery branch on P2002 and still re-enqueues writebacks', async () => {
    prismaMock.batch.findUnique
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'completed' }),
        batchFiles: [],
      } as any)
      .mockResolvedValueOnce(
        batchForEnqueue({
          batchFiles: [
            {
              ...makeBatchFile({ id: 'bf-recover' }),
              sourceFile: {
                writebackState: null,
                lastWritebackModifiedAt: null,
                batchedModifiedAt: new Date('2026-04-01'),
              },
            },
          ],
        }) as any,
      );
    stubTransactionMocks();
    // Make batchResponse.create throw the unique-constraint violation.
    const err = Object.assign(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '7.7.0',
      }),
      {},
    );
    prismaMock.batchResponse.create.mockRejectedValue(err);

    await expect(
      service.handleResults('batch-1', buildPayload(), 'duplicate-response.json'),
    ).resolves.toBeUndefined();

    // The crash-recovery branch ran enqueueWritebacks.
    expect(writebackQueue.send).toHaveBeenCalledWith({ batchFileId: 'bf-recover' });
  });

  it('swallows enqueueWritebacks errors in the crash-recovery branch (no DLQ loop)', async () => {
    prismaMock.batch.findUnique
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'completed' }),
        batchFiles: [],
      } as any)
      .mockResolvedValueOnce(
        batchForEnqueue({
          batchFiles: [
            {
              ...makeBatchFile({ id: 'bf-fail' }),
              sourceFile: {
                writebackState: null,
                lastWritebackModifiedAt: null,
                batchedModifiedAt: new Date('2026-04-01'),
              },
            },
          ],
        }) as any,
      );
    stubTransactionMocks();
    const err = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: '7.7.0',
    });
    prismaMock.batchResponse.create.mockRejectedValue(err);
    vi.mocked(writebackQueue.send).mockRejectedValue(new Error('SQS down'));

    // Must NOT throw — propagation would let SQS redrive into the same
    // AlreadyProcessedError branch and loop until DLQ.
    await expect(
      service.handleResults('batch-1', buildPayload(), 'duplicate-response.json'),
    ).resolves.toBeUndefined();
  });
});

describe('RemediationService.enqueueWritebacks', () => {
  const service = new RemediationService();

  function setup(opts: {
    institutionOptIn?: boolean;
    courseOptIn?: boolean | null;
    batchFiles: any[];
  }) {
    prismaMock.batch.findUnique.mockResolvedValue(batchForEnqueue(opts) as any);
  }

  it('returns silently when the batch is missing', async () => {
    prismaMock.batch.findUnique.mockResolvedValue(null);
    await service.enqueueWritebacks('batch-x');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('skips the whole batch when opted out', async () => {
    setup({
      institutionOptIn: false,
      batchFiles: [
        {
          ...makeBatchFile(),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: new Date('2026-04-01'),
          },
        },
      ],
    });
    await service.enqueueWritebacks('batch-1');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('course opt-out overrides institution opt-in', async () => {
    setup({
      institutionOptIn: true,
      courseOptIn: false,
      batchFiles: [
        {
          ...makeBatchFile(),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: new Date('2026-04-01'),
          },
        },
      ],
    });
    await service.enqueueWritebacks('batch-1');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('enqueues only files in a completed terminal state with both key and bucket', async () => {
    const sourceModifiedAt = new Date('2026-04-01');
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ id: 'bf-keep', sourceModifiedAt }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
        {
          ...makeBatchFile({ id: 'bf-failed', connectivoState: 'failed', sourceModifiedAt }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
        {
          ...makeBatchFile({ id: 'bf-no-bucket', remediatedS3Bucket: null, sourceModifiedAt }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
      ],
    });
    await service.enqueueWritebacks('batch-1');
    expect(writebackQueue.send).toHaveBeenCalledOnce();
    expect(writebackQueue.send).toHaveBeenCalledWith({ batchFileId: 'bf-keep' });
  });

  it('dedupes already-written-for-this-version (lastWritebackModifiedAt > sourceModifiedAt)', async () => {
    const sourceModifiedAt = new Date('2026-04-01');
    const writtenAt = new Date('2026-04-01T01:00:00Z');
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ sourceModifiedAt }),
          sourceFile: {
            writebackState: 'written',
            lastWritebackModifiedAt: writtenAt,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
      ],
    });
    await service.enqueueWritebacks('batch-1');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('dedupes already-skipped_stale to avoid SQS spam on redelivery', async () => {
    const sourceModifiedAt = new Date('2026-04-01');
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ sourceModifiedAt }),
          sourceFile: {
            writebackState: 'skipped_stale',
            lastWritebackModifiedAt: null,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
      ],
    });
    await service.enqueueWritebacks('batch-1');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('dedupes a file with a manual replace already in flight (writebackState=queued)', async () => {
    const sourceModifiedAt = new Date('2026-04-01');
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ sourceModifiedAt }),
          sourceFile: {
            writebackState: 'queued',
            lastWritebackModifiedAt: null,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
      ],
    });
    await service.enqueueWritebacks('batch-1');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('skips superseded files (sourceFile.batchedModifiedAt no longer matches batch_file)', async () => {
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ sourceModifiedAt: new Date('2026-04-01') }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: new Date('2026-04-05'),
          },
        },
      ],
    });
    await service.enqueueWritebacks('batch-1');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('throws when any send fails so SQS redrives (original-path contract)', async () => {
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ id: 'bf-1' }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: new Date('2026-04-01'),
          },
        },
        {
          ...makeBatchFile({ id: 'bf-2' }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: new Date('2026-04-01'),
          },
        },
      ],
    });
    vi.mocked(writebackQueue.send)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('SQS down'));

    await expect(service.enqueueWritebacks('batch-1')).rejects.toThrow(/partially failed/);

    // Both attempted — the loop must not abort on the first failure.
    expect(writebackQueue.send).toHaveBeenCalledTimes(2);
  });
});
