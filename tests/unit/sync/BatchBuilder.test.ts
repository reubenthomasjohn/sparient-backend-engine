import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prismaMock } from '../../setup';
import {
  makeBatch,
  makeCourse,
  makeInstitution,
  makeSourceFile,
} from '../../fixtures';
import { BatchBuilder } from '../../../src/services/sync/BatchBuilder';
import { requestPublisher } from '../../../src/services/remediation/RequestPublisher';

vi.mock('../../../src/services/remediation/RequestPublisher', () => ({
  requestPublisher: { publish: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(requestPublisher.publish).mockReset();
  vi.mocked(requestPublisher.publish).mockResolvedValue(undefined);
});

describe('BatchBuilder.buildForCourse', () => {
  const builder = new BatchBuilder();
  const institution = makeInstitution();
  const course = makeCourse();

  it('returns null when no eligible files exist', async () => {
    prismaMock.sourceFile.findMany.mockResolvedValue([]);
    const result = await builder.buildForCourse(institution, course, {
      s3Bucket: 'bucket',
    });
    expect(result).toBeNull();
    expect(prismaMock.batch.create).not.toHaveBeenCalled();
    expect(requestPublisher.publish).not.toHaveBeenCalled();
  });

  it('claims files atomically and creates a batch + batch_files', async () => {
    const sf = makeSourceFile({
      s3SourceKey: 'k1',
      s3SourceModifiedAt: new Date('2026-04-01'),
      batchedModifiedAt: null,
    });
    prismaMock.sourceFile.findMany.mockResolvedValue([sf]);
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.batch.create.mockResolvedValue(makeBatch({ id: 'new-batch', totalFiles: 1 }));
    prismaMock.batchFile.createMany.mockResolvedValue({ count: 1 });

    const result = await builder.buildForCourse(institution, course, {
      s3Bucket: 'sparient-inst-1',
      isInitialSync: true,
    });

    expect(result?.id).toBe('new-batch');
    expect(prismaMock.batch.create).toHaveBeenCalledOnce();
    expect(prismaMock.batchFile.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          batchId: 'new-batch',
          sourceFileId: sf.id,
          s3SourceKey: 'k1',
        }),
      ],
    });
    expect(requestPublisher.publish).toHaveBeenCalledOnce();
  });

  it('skips files lost to a concurrent claim (count=0)', async () => {
    const sf = makeSourceFile({
      s3SourceKey: 'k1',
      s3SourceModifiedAt: new Date('2026-04-01'),
      batchedModifiedAt: null,
    });
    prismaMock.sourceFile.findMany.mockResolvedValue([sf]);
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 0 }); // lost the race

    const result = await builder.buildForCourse(institution, course, { s3Bucket: 'b' });
    expect(result).toBeNull();
    expect(prismaMock.batch.create).not.toHaveBeenCalled();
  });

  it('rolls back claim + marks batch failed on publish error', async () => {
    const sf = makeSourceFile({
      s3SourceKey: 'k1',
      s3SourceModifiedAt: new Date('2026-04-01'),
      batchedModifiedAt: null,
      retryCount: 0,
      maxRetries: 3,
    });
    prismaMock.sourceFile.findMany.mockResolvedValue([sf]);
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.batch.create.mockResolvedValue(makeBatch({ id: 'failing-batch' }));
    prismaMock.batchFile.createMany.mockResolvedValue({ count: 1 });
    vi.mocked(requestPublisher.publish).mockRejectedValue(new Error('S3 down'));

    const result = await builder.buildForCourse(institution, course, { s3Bucket: 'b' });

    expect(result).toBeNull();
    expect(prismaMock.sourceFile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sf.id },
        data: expect.objectContaining({ batchedModifiedAt: null, lastOutcome: 'failed' }),
      }),
    );
    expect(prismaMock.batch.update).toHaveBeenCalledWith({
      where: { id: 'failing-batch' },
      data: { status: 'failed' },
    });
  });
});
