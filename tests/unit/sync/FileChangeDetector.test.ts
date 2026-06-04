import { describe, it, expect } from 'vitest';
import { prismaMock } from '../../setup';
import { makeCourse, makeSourceFile } from '../../fixtures';
import { FileChangeDetector } from '../../../src/services/sync/FileChangeDetector';
import type { DiscoveredFile } from '../../../src/types/source';

function discovered(overrides: Partial<DiscoveredFile> = {}): DiscoveredFile {
  return {
    externalId: 'cf-1',
    displayName: 'doc.pdf',
    fileName: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1000,
    modifiedAt: new Date('2026-04-01T00:00:00Z'),
    downloadUrl: 'http://canvas/files/cf-1',
    ...overrides,
  };
}

describe('FileChangeDetector.detect', () => {
  const detector = new FileChangeDetector();
  const course = makeCourse();

  it('creates a new source_file row + queues an upload for an unseen file', async () => {
    prismaMock.sourceFile.findMany.mockResolvedValue([]);
    prismaMock.sourceFile.create.mockResolvedValue(makeSourceFile({ id: 'sf-new' }));

    const result = await detector.detect(course, [discovered()]);

    expect(prismaMock.sourceFile.create).toHaveBeenCalledOnce();
    expect(result.toUploadJobs).toEqual([
      { sourceFileId: 'sf-new', modifiedAtMs: new Date('2026-04-01T00:00:00Z').getTime() },
    ]);
    expect(result.deletedCount).toBe(0);
  });

  it('bumps discoveredModifiedAt and clears outcome on a content change', async () => {
    const existing = makeSourceFile({
      discoveredModifiedAt: new Date('2026-03-01T00:00:00Z'),
      lastOutcome: 'failed',
      retryCount: 2,
    });
    prismaMock.sourceFile.findMany.mockResolvedValue([existing]);

    const result = await detector.detect(course, [
      discovered({ modifiedAt: new Date('2026-04-01T00:00:00Z') }),
    ]);

    expect(prismaMock.sourceFile.update).toHaveBeenCalledWith({
      where: { id: 'sf-1' },
      data: expect.objectContaining({
        discoveredModifiedAt: new Date('2026-04-01T00:00:00Z'),
        lastOutcome: null,
        lastFailureReason: null,
        retryCount: 0,
        nextRetryAt: null,
      }),
    });
    expect(result.toUploadJobs).toHaveLength(1);
  });

  it('refreshes metadata only on a non-content change (no upload queued)', async () => {
    const existing = makeSourceFile({
      discoveredModifiedAt: new Date('2026-04-01T00:00:00Z'),
    });
    prismaMock.sourceFile.findMany.mockResolvedValue([existing]);

    const result = await detector.detect(course, [
      discovered({
        modifiedAt: new Date('2026-04-01T00:00:00Z'), // same
        displayName: 'renamed.pdf',
      }),
    ]);

    const updateCall = prismaMock.sourceFile.update.mock.calls[0]?.[0] as any;
    expect(updateCall.data.displayName).toBe('renamed.pdf');
    expect(updateCall.data).not.toHaveProperty('discoveredModifiedAt');
    expect(result.toUploadJobs).toHaveLength(0);
  });

  it('skips files whose modifiedAt exactly matches lastWritebackModifiedAt (loop guard)', async () => {
    const writebackTime = new Date('2026-04-02T12:34:56.000Z');
    const existing = makeSourceFile({
      discoveredModifiedAt: new Date('2026-04-01T00:00:00Z'),
      lastWritebackModifiedAt: writebackTime,
    });
    prismaMock.sourceFile.findMany.mockResolvedValue([existing]);

    const result = await detector.detect(course, [
      discovered({ modifiedAt: writebackTime }),
    ]);

    expect(prismaMock.sourceFile.update).not.toHaveBeenCalled();
    expect(prismaMock.sourceFile.create).not.toHaveBeenCalled();
    expect(result.toUploadJobs).toHaveLength(0);
  });

  it('marks files missing from the discovery list as deleted', async () => {
    const existing = makeSourceFile({ canvasFileId: 'cf-gone' });
    prismaMock.sourceFile.findMany.mockResolvedValue([existing]);
    // Discovery returns a *different* canvas file id, so the detector creates a
    // row for it and flags the existing one as deleted.
    prismaMock.sourceFile.create.mockResolvedValue(makeSourceFile({ id: 'sf-new' }));

    const result = await detector.detect(course, [
      discovered({ externalId: 'cf-other' }),
    ]);

    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['sf-1'] } },
      data: { lastOutcome: 'deleted' },
    });
    expect(result.deletedCount).toBe(1);
  });

  it('mass-delete guard: empty discovery + non-empty DB → no deletes', async () => {
    prismaMock.sourceFile.findMany.mockResolvedValue([makeSourceFile()]);

    const result = await detector.detect(course, []);

    expect(prismaMock.sourceFile.updateMany).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(0);
  });
});
