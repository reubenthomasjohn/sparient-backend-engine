import { describe, it, expect } from 'vitest';
import prisma from '../../../src/db/client';
import { FileChangeDetector } from '../../../src/services/sync/FileChangeDetector';
import { createCourseFixture } from '../../fixtures';
import { DiscoveredFile } from '../../../src/types/source';

const detector = new FileChangeDetector();

// Compact builder for a DiscoveredFile with sensible defaults.
function discovered(opts: {
  externalId: string;
  modifiedAt: Date;
  mimeType?: string;
  fileName?: string;
}): DiscoveredFile {
  return {
    externalId: opts.externalId,
    displayName: opts.fileName ?? `${opts.externalId}.pdf`,
    fileName: opts.fileName ?? `${opts.externalId}.pdf`,
    mimeType: opts.mimeType ?? 'application/pdf',
    sizeBytes: 1024,
    modifiedAt: opts.modifiedAt,
    downloadUrl: `https://canvas.example/files/${opts.externalId}/download`,
  };
}

describe('FileChangeDetector.detect', () => {
  describe('new files', () => {
    it('creates a source_file row and queues an upload for an unknown file', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const modifiedAt = new Date('2026-05-10T00:00:00Z');

      const result = await detector.detect(course, [
        discovered({ externalId: 'canvas-101', modifiedAt }),
      ]);

      expect(result.deletedCount).toBe(0);
      expect(result.toUploadJobs).toHaveLength(1);
      expect(result.toUploadJobs[0].modifiedAtMs).toBe(modifiedAt.getTime());

      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { courseId: fx.courseId, canvasFileId: 'canvas-101' },
      });
      expect(stored.discoveredModifiedAt).toEqual(modifiedAt);
      expect(stored.lastOutcome).toBeNull();
    });
  });

  describe('existing files', () => {
    it('updates discoveredModifiedAt and re-queues upload when Canvas reports a newer modifiedAt', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const oldMod = new Date('2026-05-01T00:00:00Z');
      const newMod = new Date('2026-05-10T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'canvas-101',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: oldMod,
          lastOutcome: 'completed', // simulate a previous successful cycle
        },
      });

      const result = await detector.detect(course, [
        discovered({ externalId: 'canvas-101', modifiedAt: newMod }),
      ]);

      expect(result.toUploadJobs).toHaveLength(1);
      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { courseId: fx.courseId, canvasFileId: 'canvas-101' },
      });
      expect(stored.discoveredModifiedAt).toEqual(newMod);
      // Newer version invalidates the prior terminal outcome.
      expect(stored.lastOutcome).toBeNull();
      expect(stored.retryCount).toBe(0);
    });

    it('is a no-op when Canvas reports the same modifiedAt', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'canvas-101',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: mod,
          lastOutcome: 'completed',
        },
      });

      const result = await detector.detect(course, [
        discovered({ externalId: 'canvas-101', modifiedAt: mod }),
      ]);

      expect(result.toUploadJobs).toHaveLength(0);
      // lastOutcome should be untouched.
      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { courseId: fx.courseId, canvasFileId: 'canvas-101' },
      });
      expect(stored.lastOutcome).toBe('completed');
    });

    it('skips a file whose modifiedAt equals our last writeback (we wrote it)', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const wbMod = new Date('2026-05-10T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'canvas-101',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
          lastOutcome: 'completed',
          lastWritebackModifiedAt: wbMod,
        },
      });

      const result = await detector.detect(course, [
        // Canvas reports the file with the modifiedAt we set when we wrote back.
        discovered({ externalId: 'canvas-101', modifiedAt: wbMod }),
      ]);

      // No upload should be queued — this is our own writeback bouncing back.
      expect(result.toUploadJobs).toHaveLength(0);
    });
  });

  describe('deletion detection', () => {
    it('marks a file deleted when it no longer appears in discovery', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'canvas-101',
          displayName: 'gone.pdf',
          fileName: 'gone.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
          lastOutcome: 'completed',
        },
      });

      const result = await detector.detect(course, [
        discovered({ externalId: 'canvas-other', modifiedAt: new Date() }),
      ]);

      expect(result.deletedCount).toBe(1);
      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { courseId: fx.courseId, canvasFileId: 'canvas-101' },
      });
      expect(stored.lastOutcome).toBe('deleted');
    });

    it('refuses to mark anything deleted when Canvas returns an empty list (auth/scope failure guard)', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'canvas-101',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
          lastOutcome: 'completed',
        },
      });

      const result = await detector.detect(course, []);

      expect(result.deletedCount).toBe(0);
      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { courseId: fx.courseId, canvasFileId: 'canvas-101' },
      });
      // Untouched — not deleted.
      expect(stored.lastOutcome).toBe('completed');
    });

    it('does not mark out-of-scope files deleted (allowlist scope guard)', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });

      // Two existing rows: one in scope, one OUT of scope of the current allowlist.
      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'in-scope',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
          lastOutcome: 'completed',
        },
      });
      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'out-of-scope',
          displayName: 'a.zip',
          fileName: 'a.zip',
          mimeType: 'application/zip',
          discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
          lastOutcome: 'completed',
        },
      });

      // Discovery returns a different file (so the existing rows look "missing"),
      // but only 'application/pdf' is in the current allowlist.
      const result = await detector.detect(
        course,
        [discovered({ externalId: 'something-else', modifiedAt: new Date() })],
        { allowedMimeTypes: new Set(['application/pdf']) },
      );

      // Only the in-scope row should be marked deleted; out-of-scope is left alone.
      expect(result.deletedCount).toBe(1);
      const inScope = await prisma.sourceFile.findFirstOrThrow({
        where: { canvasFileId: 'in-scope' },
      });
      const outOfScope = await prisma.sourceFile.findFirstOrThrow({
        where: { canvasFileId: 'out-of-scope' },
      });
      expect(inScope.lastOutcome).toBe('deleted');
      expect(outOfScope.lastOutcome).toBe('completed');
    });

    it('normalizes mime type with charset suffix before scope check', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });

      // Canvas returns this stored mimeType with a charset suffix.
      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'csv-file',
          displayName: 'data.csv',
          fileName: 'data.csv',
          mimeType: 'text/csv; charset=utf-8',
          discoveredModifiedAt: new Date('2026-05-01T00:00:00Z'),
          lastOutcome: 'completed',
        },
      });

      const result = await detector.detect(
        course,
        [discovered({ externalId: 'something-else', modifiedAt: new Date() })],
        { allowedMimeTypes: new Set(['text/csv']) }, // bare, no suffix
      );

      // Should be in scope after normalization → marked deleted.
      expect(result.deletedCount).toBe(1);
    });
  });

  describe('reappear after deleted', () => {
    it('clears the deleted state and re-queues upload when a previously-deleted file reappears', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');

      // Existing row was marked deleted (e.g. allowlist narrowed).
      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'reappeared',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: mod,
          lastOutcome: 'deleted',
          batchedModifiedAt: mod, // pretend it had been batched at some point
        },
      });

      // Now Canvas reports it again with the SAME modifiedAt (allowlist re-widened).
      const result = await detector.detect(course, [
        discovered({ externalId: 'reappeared', modifiedAt: mod }),
      ]);

      expect(result.toUploadJobs).toHaveLength(1);
      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { canvasFileId: 'reappeared' },
      });
      expect(stored.lastOutcome).toBeNull();
      // batchedModifiedAt must be cleared so BatchBuilder will re-claim despite
      // the unchanged discoveredModifiedAt.
      expect(stored.batchedModifiedAt).toBeNull();
    });

    it('handles a reappeared file that ALSO has a newer modifiedAt (favors the isNewer branch)', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const oldMod = new Date('2026-05-01T00:00:00Z');
      const newMod = new Date('2026-05-10T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'reappeared',
          displayName: 'a.pdf',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          discoveredModifiedAt: oldMod,
          lastOutcome: 'deleted',
        },
      });

      const result = await detector.detect(course, [
        discovered({ externalId: 'reappeared', modifiedAt: newMod }),
      ]);

      expect(result.toUploadJobs).toHaveLength(1);
      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { canvasFileId: 'reappeared' },
      });
      expect(stored.lastOutcome).toBeNull();
      expect(stored.discoveredModifiedAt).toEqual(newMod);
    });
  });

  describe('metadata updates', () => {
    it('updates displayName/fileName/mimeType/sizeBytes even when modifiedAt is unchanged', async () => {
      const fx = await createCourseFixture();
      const course = await prisma.course.findUniqueOrThrow({ where: { id: fx.courseId } });
      const mod = new Date('2026-05-01T00:00:00Z');

      await prisma.sourceFile.create({
        data: {
          courseId: fx.courseId,
          canvasFileId: 'canvas-101',
          displayName: 'old-name.pdf',
          fileName: 'old-name.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1000,
          discoveredModifiedAt: mod,
        },
      });

      await detector.detect(course, [
        {
          externalId: 'canvas-101',
          displayName: 'new-display.pdf',
          fileName: 'new-name.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2000,
          modifiedAt: mod,
          downloadUrl: 'https://canvas.example/x',
        },
      ]);

      const stored = await prisma.sourceFile.findFirstOrThrow({
        where: { canvasFileId: 'canvas-101' },
      });
      expect(stored.displayName).toBe('new-display.pdf');
      expect(stored.fileName).toBe('new-name.pdf');
      expect(stored.sizeBytes).toBe(BigInt(2000));
    });
  });
});
