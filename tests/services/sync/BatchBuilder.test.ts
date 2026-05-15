import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../../src/db/client';
import { createCourseFixture } from '../../fixtures';

// Mock RequestPublisher BEFORE importing BatchBuilder — BatchBuilder pulls in
// the `requestPublisher` singleton at module load. The default mock resolves
// successfully; individual tests can re-stub for failure paths.
const publishMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/remediation/RequestPublisher', () => ({
  requestPublisher: {
    publish: publishMock,
    buildKey: (id: string) => `${id}.json`,
  },
  RequestPublisher: class {},
}));

const { BatchBuilder } = await import('../../../src/services/sync/BatchBuilder');
const builder = new BatchBuilder();

beforeEach(() => {
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
});

// Helper: seed an eligible source_file row (uploaded, never batched yet).
async function seedEligibleFile(
  courseId: string,
  canvasFileId: string,
  s3SourceModifiedAt: Date,
): Promise<{ id: string }> {
  return prisma.sourceFile.create({
    data: {
      courseId,
      canvasFileId,
      displayName: `${canvasFileId}.pdf`,
      fileName: `${canvasFileId}.pdf`,
      mimeType: 'application/pdf',
      discoveredModifiedAt: s3SourceModifiedAt,
      s3SourceKey: `incoming/${canvasFileId}/v-${s3SourceModifiedAt.getTime()}/file.pdf`,
      s3SourceBucket: 'test-bucket',
      s3SourceModifiedAt,
    },
    select: { id: true },
  });
}

describe('BatchBuilder.buildForCourse', () => {
  describe('eligibility', () => {
    it('returns null when no files are eligible', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });

      const result = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(result).toBeNull();
      expect(publishMock).not.toHaveBeenCalled();
    });

    it('claims a never-batched file and creates a batch', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');
      const sf = await seedEligibleFile(fx.courseId, 'canvas-101', mod);

      const batch = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });

      expect(batch).not.toBeNull();
      expect(batch!.totalFiles).toBe(1);

      const stored = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
      expect(stored.batchedModifiedAt).toEqual(mod);

      const batchFiles = await prisma.batchFile.findMany({ where: { batchId: batch!.id } });
      expect(batchFiles).toHaveLength(1);

      expect(publishMock).toHaveBeenCalledOnce();
    });

    it('does not claim a file with no s3SourceKey (not yet uploaded)', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'not-uploaded',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
          // s3SourceKey and s3SourceModifiedAt deliberately NULL.
        },
      });

      const result = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(result).toBeNull();
    });

    it('does not claim a file marked permanently_failed', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'pf',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: mod,
          s3SourceKey: 'k',
          s3SourceModifiedAt: mod,
          lastOutcome: 'permanently_failed',
        },
      });

      const result = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(result).toBeNull();
    });

    it('does not claim a file marked deleted', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'del',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: mod,
          s3SourceKey: 'k',
          s3SourceModifiedAt: mod,
          lastOutcome: 'deleted',
        },
      });

      const result = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(result).toBeNull();
    });

    it('skips a file already at the current s3SourceModifiedAt (already batched at this version)', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'already',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: mod,
          s3SourceKey: 'k',
          s3SourceModifiedAt: mod,
          batchedModifiedAt: mod, // already batched at this version
        },
      });

      const result = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(result).toBeNull();
    });

    it('re-claims a file when s3SourceModifiedAt is newer than batchedModifiedAt', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const oldMod = new Date('2026-05-01T00:00:00Z');
      const newMod = new Date('2026-05-10T00:00:00Z');

      const sf = await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'newer',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: newMod,
          s3SourceKey: 'k-new',
          s3SourceModifiedAt: newMod,
          batchedModifiedAt: oldMod, // previously batched at the older version
          lastOutcome: 'completed',
        },
        select: { id: true },
      });

      const batch = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(batch).not.toBeNull();

      const stored = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
      expect(stored.batchedModifiedAt).toEqual(newMod);
      // Claim clears prior terminal state so the new outcome is unambiguous.
      expect(stored.lastOutcome).toBeNull();
    });
  });

  describe('publish failure rollback', () => {
    it('rolls back the claim and marks the batch failed when publish throws', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');
      const sf = await seedEligibleFile(fx.courseId, 'canvas-101', mod);

      publishMock.mockRejectedValueOnce(new Error('S3 putObject timeout'));

      const result = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(result).toBeNull();

      // Source file's batched_modified_at is rolled back AND retry counter advanced.
      const stored = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
      expect(stored.batchedModifiedAt).toBeNull();
      expect(stored.retryCount).toBe(1);
      expect(stored.lastOutcome).toBe('failed');
      expect(stored.lastFailureReason).toMatch(/S3 putObject timeout/);

      // The batch row still exists but is marked failed.
      const batches = await prisma.batch.findMany({ where: { courseId: fx.courseId } });
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe('failed');
    });
  });

  describe('multiple files', () => {
    it('batches multiple eligible files into a single batch', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');

      await seedEligibleFile(fx.courseId, 'a', mod);
      await seedEligibleFile(fx.courseId, 'b', mod);
      await seedEligibleFile(fx.courseId, 'c', mod);

      const batch = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
      });
      expect(batch).not.toBeNull();
      expect(batch!.totalFiles).toBe(3);

      const batchFiles = await prisma.batchFile.findMany({ where: { batchId: batch!.id } });
      expect(batchFiles).toHaveLength(3);
    });
  });

  describe('options passthrough', () => {
    it('propagates isInitialSync and isRetry to the batch row', async () => {
      const fx = await createCourseFixture();
      const institution = await prisma.institution.findUniqueOrThrow({
        where: { id: fx.institutionId },
      });
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      await seedEligibleFile(fx.courseId, 'a', new Date('2026-05-01T00:00:00Z'));

      const batch = await builder.buildForCourse(institution, course, {
        s3Bucket: 'test-bucket',
        isInitialSync: true,
        isRetry: true,
      });

      expect(batch!.isInitialSync).toBe(true);
      expect(batch!.isRetry).toBe(true);
    });
  });
});

describe('BatchBuilder.buildForFile', () => {
  it('throws when sourceFile is missing s3SourceKey', async () => {
    const fx = await createCourseFixture();
    const institution = await prisma.institution.findUniqueOrThrow({
      where: { id: fx.institutionId },
    });
    const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });

    const sf = await prisma.sourceFile.create({
      data: {
        courseId: fx.courseId,
        canvasFileId: 'no-key',
        displayName: 'a.pdf',
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
        // No s3SourceKey, no s3SourceModifiedAt
      },
    });

    await expect(builder.buildForFile(institution, course, sf, { s3Bucket: 'test-bucket' }))
      .rejects.toThrow(/missing s3SourceKey/);
  });

  it('creates a single-file batch when no in-flight batch exists', async () => {
    const fx = await createCourseFixture();
    const institution = await prisma.institution.findUniqueOrThrow({
      where: { id: fx.institutionId },
    });
    const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
    const mod = new Date('2026-05-01T00:00:00Z');

    const sf = await prisma.sourceFile.create({
      data: {
        courseId: fx.courseId,
        canvasFileId: 'solo',
        displayName: 'a.pdf',
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        discoveredModifiedAt: mod,
        s3SourceKey: 'k',
        s3SourceModifiedAt: mod,
      },
    });

    const result = await builder.buildForFile(institution, course, sf, {
      s3Bucket: 'test-bucket',
    });

    expect(result.wasAlreadyInFlight).toBe(false);
    expect(result.batchId).toBeTruthy();

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch.totalFiles).toBe(1);

    const stored = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(stored.batchedModifiedAt).toEqual(mod);

    expect(publishMock).toHaveBeenCalledOnce();
  });

  it('returns the existing in-flight batchId when one already exists for this file', async () => {
    const fx = await createCourseFixture();
    const institution = await prisma.institution.findUniqueOrThrow({
      where: { id: fx.institutionId },
    });
    const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
    const mod = new Date('2026-05-01T00:00:00Z');

    const sf = await prisma.sourceFile.create({
      data: {
        courseId: fx.courseId,
        canvasFileId: 'inflight',
        displayName: 'a.pdf',
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        discoveredModifiedAt: mod,
        s3SourceKey: 'k',
        s3SourceModifiedAt: mod,
      },
    });

    // Pre-existing pending batch for the same source file.
    const existingBatch = await prisma.batch.create({
      data: {
        institutionId: fx.institutionId,
        courseId: fx.courseId,
        status: 'pending',
        totalFiles: 1,
        batchFiles: {
          create: {
            sourceFileId: sf.id,
            canvasFileId: 'inflight',
            s3SourceKey: 'k',
            sourceModifiedAt: mod,
          },
        },
      },
    });

    const result = await builder.buildForFile(institution, course, sf, {
      s3Bucket: 'test-bucket',
    });

    expect(result.wasAlreadyInFlight).toBe(true);
    expect(result.batchId).toBe(existingBatch.id);

    // Should NOT have created a second batch or re-published.
    const allBatches = await prisma.batch.findMany({ where: { courseId: fx.courseId } });
    expect(allBatches).toHaveLength(1);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('throws badGateway and rolls back on publish failure', async () => {
    const fx = await createCourseFixture();
    const institution = await prisma.institution.findUniqueOrThrow({
      where: { id: fx.institutionId },
    });
    const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
    const mod = new Date('2026-05-01T00:00:00Z');

    const sf = await prisma.sourceFile.create({
      data: {
        courseId: fx.courseId,
        canvasFileId: 'fail',
        displayName: 'a.pdf',
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        discoveredModifiedAt: mod,
        s3SourceKey: 'k',
        s3SourceModifiedAt: mod,
      },
    });

    publishMock.mockRejectedValueOnce(new Error('boom'));

    await expect(
      builder.buildForFile(institution, course, sf, { s3Bucket: 'test-bucket' }),
    ).rejects.toMatchObject({ statusCode: 502 });

    // Source file's batched_modified_at rolled back.
    const stored = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(stored.batchedModifiedAt).toBeNull();
    expect(stored.lastOutcome).toBe('failed');

    // Batch row marked failed.
    const batches = await prisma.batch.findMany({ where: { courseId: fx.courseId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].status).toBe('failed');
  });
});
