import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prismaMock } from '../../setup';
import {
  makeBatch,
  makeBatchFile,
  makeCourse,
  makeInstitution,
  makeSourceFile,
} from '../../fixtures';
import {
  RemediationService,
  stripBucketFromPath,
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

describe('stripBucketFromPath', () => {
  it.each([
    ['/bucket/connectivo-remediated/foo.pdf', 'connectivo-remediated/foo.pdf'],
    ['//bucket/connectivo-remediated/foo.pdf', 'connectivo-remediated/foo.pdf'],
    ['bucket/connectivo-remediated/foo.pdf', 'connectivo-remediated/foo.pdf'],
    ['/bucket/key.pdf', 'key.pdf'],
  ])('returns the post-bucket portion: %s -> %s', (input, expected) => {
    expect(stripBucketFromPath(input)).toBe(expected);
  });

  it.each([
    ['/bucket/'], // bucket but no key
    ['/bucket'],  // no separator after bucket
    ['bucket-only'],
    [''],
  ])('returns null for malformed input: %s', (input) => {
    expect(stripBucketFromPath(input)).toBeNull();
  });
});

describe('RemediationService.handleResults', () => {
  const service = new RemediationService();

  function payload(overrides: Partial<ConnectivoResultsPayload> = {}): ConnectivoResultsPayload {
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

  it('throws when the batch does not exist', async () => {
    prismaMock.batch.findUnique.mockResolvedValue(null);
    await expect(service.handleResults('batch-x', payload())).rejects.toThrow();
  });

  it('re-runs enqueueWritebacks for an already-terminal batch (idempotent re-delivery)', async () => {
    prismaMock.batch.findUnique
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'completed' }),
        batchFiles: [],
      } as any)
      // second call from inside enqueueWritebacks
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'completed' }),
        institution: { writebackOptIn: true },
        course: { writebackOptIn: null },
        batchFiles: [],
      } as any);

    await service.handleResults('batch-1', payload());

    // No state writes, no transaction — just the dedupe pass.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('marks files missing from the response as failed', async () => {
    prismaMock.batch.findUnique
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'pending' }),
        batchFiles: [
          { ...makeBatchFile({ id: 'bf-1', sourceFileId: 'sf-1' }), sourceFile: makeSourceFile() },
        ],
      } as any)
      // for enqueueWritebacks at end
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'completed' }),
        institution: { writebackOptIn: false },
        course: { writebackOptIn: null },
        batchFiles: [],
      } as any);

    // Empty folders: no files to match.
    await service.handleResults('batch-1', payload({ folders: [] }));

    expect(prismaMock.batchFile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bf-1' },
        data: expect.objectContaining({ connectivoState: 'failed' }),
      }),
    );
  });
});

describe('RemediationService.enqueueWritebacks (via handleResults terminal path)', () => {
  const service = new RemediationService();

  function setup(opts: {
    institutionOptIn?: boolean;
    courseOptIn?: boolean | null;
    batchFiles: ReturnType<typeof makeBatchFile & { sourceFile?: any }>[] | any[];
  }) {
    prismaMock.batch.findUnique
      // First call (handleResults entry)
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'completed' }),
        batchFiles: [],
      } as any)
      // Second call (enqueueWritebacks)
      .mockResolvedValueOnce({
        ...makeBatch({ status: 'completed' }),
        institution: { writebackOptIn: opts.institutionOptIn ?? true },
        course: { writebackOptIn: opts.courseOptIn ?? null },
        batchFiles: opts.batchFiles,
      } as any);
  }

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
    await service.handleResults('batch-1', {} as any);
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
          // failed → drop
          ...makeBatchFile({ id: 'bf-failed', connectivoState: 'failed', sourceModifiedAt }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
        {
          // missing bucket → drop
          ...makeBatchFile({ id: 'bf-no-bucket', remediatedS3Bucket: null, sourceModifiedAt }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: sourceModifiedAt,
          },
        },
      ],
    });
    await service.handleResults('batch-1', {} as any);
    expect(writebackQueue.send).toHaveBeenCalledOnce();
    expect(writebackQueue.send).toHaveBeenCalledWith({ batchFileId: 'bf-keep' });
  });

  it('dedupes already-written-for-this-version (lastWritebackModifiedAt > sourceModifiedAt)', async () => {
    const sourceModifiedAt = new Date('2026-04-01');
    const writtenAt = new Date('2026-04-01T01:00:00Z'); // strictly later
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
    await service.handleResults('batch-1', {} as any);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('enqueues a new cycle even if a prior cycle was written-back', async () => {
    // Cycle 2: source_file's lastWritebackModifiedAt is from cycle 1 (earlier than this batch's
    // sourceModifiedAt). Dedupe must NOT fire.
    const cycle1Written = new Date('2026-04-01T01:00:00Z');
    const cycle2SourceModified = new Date('2026-04-05'); // newer
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ sourceModifiedAt: cycle2SourceModified }),
          sourceFile: {
            writebackState: 'written',
            lastWritebackModifiedAt: cycle1Written,
            batchedModifiedAt: cycle2SourceModified,
          },
        },
      ],
    });
    await service.handleResults('batch-1', {} as any);
    expect(writebackQueue.send).toHaveBeenCalledOnce();
  });

  it('skips superseded files (sourceFile.batchedModifiedAt no longer matches batch_file)', async () => {
    setup({
      batchFiles: [
        {
          ...makeBatchFile({ sourceModifiedAt: new Date('2026-04-01') }),
          sourceFile: {
            writebackState: null,
            lastWritebackModifiedAt: null,
            batchedModifiedAt: new Date('2026-04-05'), // claimed by newer batch
          },
        },
      ],
    });
    await service.handleResults('batch-1', {} as any);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('throws when any send fails so SQS redrives', async () => {
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

    await expect(service.handleResults('batch-1', {} as any)).rejects.toThrow(/partially failed/);

    // Both attempted — the loop must not abort on the first failure.
    expect(writebackQueue.send).toHaveBeenCalledTimes(2);
  });
});
