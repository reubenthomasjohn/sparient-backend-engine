import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../src/db/client';
import { BatchBuilder } from '../../src/services/sync/BatchBuilder';
import { requestPublisher } from '../../src/services/remediation/RequestPublisher';
import { seedCourse, seedInstitution, seedSourceFile } from './seed';

vi.mock('../../src/services/remediation/RequestPublisher', () => ({
  requestPublisher: { publish: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(requestPublisher.publish).mockReset();
  vi.mocked(requestPublisher.publish).mockResolvedValue(undefined);
});

describe('BatchBuilder integration', () => {
  const builder = new BatchBuilder();

  it('claims eligible files and creates batch + batch_files atomically', async () => {
    const institution = await seedInstitution();
    const course = await seedCourse(institution.id);
    const sf = await seedSourceFile(course.id);

    const batch = await builder.buildForCourse(institution, course, {
      s3Bucket: 'sparient-int',
    });

    expect(batch).not.toBeNull();
    const batchFiles = await prisma.batchFile.findMany({ where: { batchId: batch!.id } });
    expect(batchFiles).toHaveLength(1);
    expect(batchFiles[0].sourceFileId).toBe(sf.id);

    const refreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(refreshed.batchedModifiedAt?.getTime()).toBe(sf.s3SourceModifiedAt!.getTime());
  });

  it('two parallel buildForCourse calls only produce one batch (atomic claim)', async () => {
    // The most important integration property: the conditional UPDATE inside
    // the transaction must serialize concurrent claimers. If two SFN executions
    // race on the same eligible file, exactly one wins.
    const institution = await seedInstitution();
    const course = await seedCourse(institution.id);
    await seedSourceFile(course.id);

    const [a, b] = await Promise.all([
      builder.buildForCourse(institution, course, { s3Bucket: 'b' }),
      builder.buildForCourse(institution, course, { s3Bucket: 'b' }),
    ]);

    const allBatches = await prisma.batch.findMany();
    const allBatchFiles = await prisma.batchFile.findMany();

    // One winner, one no-op:
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
    expect(allBatches).toHaveLength(1);
    expect(allBatchFiles).toHaveLength(1);
  });

  it('rolls back claim + marks batch failed when publish throws', async () => {
    const institution = await seedInstitution();
    const course = await seedCourse(institution.id);
    const sf = await seedSourceFile(course.id);
    vi.mocked(requestPublisher.publish).mockRejectedValueOnce(new Error('S3 down'));

    const result = await builder.buildForCourse(institution, course, { s3Bucket: 'b' });
    expect(result).toBeNull();

    const refreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(refreshed.batchedModifiedAt).toBeNull();
    expect(refreshed.lastOutcome).toBe('failed');
    expect(refreshed.retryCount).toBe(1);

    const batches = await prisma.batch.findMany();
    expect(batches).toHaveLength(1);
    expect(batches[0].status).toBe('failed');
  });

  it('does nothing when no files are eligible', async () => {
    const institution = await seedInstitution();
    const course = await seedCourse(institution.id);
    // file is already batched at its current version
    const modAt = new Date('2026-04-01T00:00:00Z');
    await seedSourceFile(course.id, {
      s3SourceModifiedAt: modAt,
      batchedModifiedAt: modAt,
    });

    const result = await builder.buildForCourse(institution, course, { s3Bucket: 'b' });
    expect(result).toBeNull();
    expect(await prisma.batch.count()).toBe(0);
  });
});
