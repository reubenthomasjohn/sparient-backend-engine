import { describe, it, expect } from 'vitest';
import prisma from '../../src/db/client';
import { FileChangeDetector } from '../../src/services/sync/FileChangeDetector';
import { seedCourse, seedInstitution, seedSourceFile } from './seed';
import type { DiscoveredFile } from '../../src/types/source';

const detector = new FileChangeDetector();

function discovered(overrides: Partial<DiscoveredFile> = {}): DiscoveredFile {
  return {
    externalId: 'cf-1',
    displayName: 'doc.pdf',
    fileName: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1000,
    modifiedAt: new Date('2026-04-05T00:00:00Z'),
    downloadUrl: 'http://x',
    ...overrides,
  };
}

describe('FileChangeDetector integration', () => {
  it('inserts a new source_file when discovery turns up an unseen file', async () => {
    const inst = await seedInstitution();
    const course = await seedCourse(inst.id);

    const result = await detector.detect(course, [discovered({ externalId: 'new-file' })]);

    expect(result.toUploadJobs).toHaveLength(1);
    const created = await prisma.sourceFile.findFirstOrThrow({
      where: { courseId: course.id, canvasFileId: 'new-file' },
    });
    expect(created.discoveredModifiedAt.toISOString()).toBe('2026-04-05T00:00:00.000Z');
  });

  it('writeback-loop guard: skips files whose modifiedAt matches lastWritebackModifiedAt', async () => {
    const inst = await seedInstitution();
    const course = await seedCourse(inst.id);
    const stampedAt = new Date('2026-04-05T00:00:00Z');
    const sf = await seedSourceFile(course.id, {
      discoveredModifiedAt: new Date('2026-04-01T00:00:00Z'),
      lastWritebackModifiedAt: stampedAt,
    });

    const result = await detector.detect(course, [discovered({ modifiedAt: stampedAt })]);

    expect(result.toUploadJobs).toHaveLength(0);
    // The source row should not have been touched.
    const refreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(refreshed.discoveredModifiedAt.getTime()).toBe(
      new Date('2026-04-01T00:00:00Z').getTime(),
    );
  });

  it('marks orphan files as deleted when discovery returns a smaller list', async () => {
    const inst = await seedInstitution();
    const course = await seedCourse(inst.id);
    const sf = await seedSourceFile(course.id, { canvasFileId: 'gone' });

    const result = await detector.detect(course, [discovered({ externalId: 'still-here' })]);

    expect(result.deletedCount).toBe(1);
    const refreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(refreshed.lastOutcome).toBe('deleted');
  });

  it('mass-delete guard: empty discovery + non-empty DB → no deletions', async () => {
    const inst = await seedInstitution();
    const course = await seedCourse(inst.id);
    const sf = await seedSourceFile(course.id);

    const result = await detector.detect(course, []);

    expect(result.deletedCount).toBe(0);
    const refreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(refreshed.lastOutcome).toBeNull();
  });

  it('content change clears retry counters and outcome, queues an upload', async () => {
    const inst = await seedInstitution();
    const course = await seedCourse(inst.id);
    const sf = await seedSourceFile(course.id, {
      discoveredModifiedAt: new Date('2026-04-01T00:00:00Z'),
      lastOutcome: 'failed',
      lastFailureReason: 'old',
      retryCount: 2,
      nextRetryAt: new Date('2026-04-02T00:00:00Z'),
    });

    const result = await detector.detect(course, [
      discovered({ modifiedAt: new Date('2026-04-05T00:00:00Z') }),
    ]);

    expect(result.toUploadJobs).toHaveLength(1);
    const refreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(refreshed.discoveredModifiedAt.toISOString()).toBe('2026-04-05T00:00:00.000Z');
    expect(refreshed.lastOutcome).toBeNull();
    expect(refreshed.retryCount).toBe(0);
    expect(refreshed.nextRetryAt).toBeNull();
  });
});
