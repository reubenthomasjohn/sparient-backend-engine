import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { prismaMock } from '../../setup';
import {
  makeBatchFile,
  makeCourse,
  makeInstitution,
  makeSourceFile,
} from '../../fixtures';
import { WritebackService } from '../../../src/services/writeback/WritebackService';
import { SourceRegistry } from '../../../src/services/sources/SourceRegistry';
import type { ISourceClient } from '../../../src/services/sources/ISourceClient';

// Hoisted out of beforeEach so each test gets a fresh stub but the type stays inferred.
let sourceClient: DeepMockProxy<ISourceClient>;

beforeEach(() => {
  sourceClient = mockDeep<ISourceClient>();
  vi.spyOn(SourceRegistry, 'getClient').mockReturnValue(sourceClient);
});

// Helper: stitch together the include shape that WritebackService.findUnique expects.
function batchFileWithRelations(opts: {
  batchFile?: Parameters<typeof makeBatchFile>[0];
  sourceFile?: Parameters<typeof makeSourceFile>[0];
  course?: Parameters<typeof makeCourse>[0];
  institution?: Parameters<typeof makeInstitution>[0];
} = {}) {
  return {
    ...makeBatchFile(opts.batchFile),
    sourceFile: {
      ...makeSourceFile(opts.sourceFile),
      course: {
        ...makeCourse(opts.course),
        institution: makeInstitution(opts.institution),
      },
    },
  };
}

describe('WritebackService.writeBack', () => {
  const service = new WritebackService();

  it('drops the job when the batch_file is not found', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(null);
    await service.writeBack('missing');
    expect(sourceClient.replaceFile).not.toHaveBeenCalled();
    // Neither write path should fire: success uses updateMany (B2 supersession
    // guard), skipped_stale + failed paths also use updateMany. The legacy
    // `update` is unused — assert both shapes to lock that in.
    expect(prismaMock.sourceFile.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.sourceFile.update).not.toHaveBeenCalled();
  });

  it('skips when connectivoState is not a completed terminal state', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({ batchFile: { connectivoState: 'failed' } }) as any,
    );
    await service.writeBack('bf-1');
    expect(sourceClient.replaceFile).not.toHaveBeenCalled();
  });

  it('skips when remediatedS3Key is null', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({ batchFile: { remediatedS3Key: null } }) as any,
    );
    await service.writeBack('bf-1');
    expect(sourceClient.replaceFile).not.toHaveBeenCalled();
  });

  it('skips when remediatedS3Bucket is null', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({ batchFile: { remediatedS3Bucket: null } }) as any,
    );
    await service.writeBack('bf-1');
    expect(sourceClient.replaceFile).not.toHaveBeenCalled();
  });

  it('skips when both institution and course opt out', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({
        institution: { writebackOptIn: false },
        course: { writebackOptIn: null },
      }) as any,
    );
    await service.writeBack('bf-1');
    expect(sourceClient.replaceFile).not.toHaveBeenCalled();
  });

  it('skips when course override is false (even if institution is true)', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({
        institution: { writebackOptIn: true },
        course: { writebackOptIn: false },
      }) as any,
    );
    await service.writeBack('bf-1');
    expect(sourceClient.replaceFile).not.toHaveBeenCalled();
  });

  it('proceeds when course override is true and institution is false', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({
        institution: { writebackOptIn: false },
        course: { writebackOptIn: true },
      }) as any,
    );
    sourceClient.replaceFile.mockResolvedValue({
      status: 'replaced',
      file: {
        externalId: 'cf-1',
        displayName: 'doc.pdf',
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        modifiedAt: new Date('2026-04-02T00:00:00Z'),
        downloadUrl: 'http://x',
      },
    });
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 } as any);
    await service.writeBack('bf-1');
    expect(sourceClient.replaceFile).toHaveBeenCalledOnce();
  });

  it('skips on supersession (newer batch claimed the source_file)', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({
        batchFile: { sourceModifiedAt: new Date('2026-04-01') },
        sourceFile: { batchedModifiedAt: new Date('2026-04-05') }, // newer
      }) as any,
    );
    await service.writeBack('bf-1');
    expect(sourceClient.replaceFile).not.toHaveBeenCalled();
  });

  it('passes batchFile.sourceModifiedAt as knownModifiedAt (not discoveredModifiedAt)', async () => {
    const sourceModifiedAt = new Date('2026-04-01T00:00:00Z');
    const discoveredModifiedAt = new Date('2026-04-10T00:00:00Z'); // teacher edited later

    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({
        batchFile: { sourceModifiedAt },
        sourceFile: { batchedModifiedAt: sourceModifiedAt, discoveredModifiedAt },
      }) as any,
    );
    sourceClient.replaceFile.mockResolvedValue({
      status: 'skipped',
      reason: 'modified',
    });

    await service.writeBack('bf-1');

    expect(sourceClient.replaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        knownModifiedAt: sourceModifiedAt,
        s3Bucket: 'sparient-inst-1',
        s3Key: 'connectivo-remediated/course-1/cf-1.pdf',
        mimeType: 'application/pdf',
      }),
    );
  });

  it('records skipped_stale with a guarded updateMany', async () => {
    prismaMock.batchFile.findUnique.mockResolvedValue(batchFileWithRelations() as any);
    sourceClient.replaceFile.mockResolvedValue({ status: 'skipped', reason: 'modified' });

    await service.writeBack('bf-1');

    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'sf-1',
        OR: [{ writebackState: null }, { writebackState: 'failed' }],
      },
      data: { writebackState: 'skipped_stale' },
    });
    expect(prismaMock.sourceFile.update).not.toHaveBeenCalled();
  });

  it('records written + lastWritebackModifiedAt on success (guarded against stale writers)', async () => {
    const sourceModifiedAt = new Date('2026-04-01T00:00:00Z');
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({
        batchFile: { sourceModifiedAt },
        sourceFile: { batchedModifiedAt: sourceModifiedAt },
      }) as any,
    );
    const newModifiedAt = new Date('2026-04-02T12:00:00Z');
    sourceClient.replaceFile.mockResolvedValue({
      status: 'replaced',
      file: {
        externalId: 'cf-1',
        displayName: 'doc.pdf',
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        modifiedAt: newModifiedAt,
        downloadUrl: 'http://x',
      },
    });
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 } as any);

    await service.writeBack('bf-1');

    // Guard: only stamp when batchedModifiedAt still matches our sourceModifiedAt
    // — prevents a stale writeback from clobbering a newer batch's stamp.
    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledWith({
      where: { id: 'sf-1', batchedModifiedAt: sourceModifiedAt },
      data: { writebackState: 'written', lastWritebackModifiedAt: newModifiedAt },
    });
  });

  it('does not stamp success when supersession-guard updateMany returns count=0', async () => {
    const sourceModifiedAt = new Date('2026-04-01T00:00:00Z');
    prismaMock.batchFile.findUnique.mockResolvedValue(
      batchFileWithRelations({
        batchFile: { sourceModifiedAt },
        sourceFile: { batchedModifiedAt: sourceModifiedAt },
      }) as any,
    );
    sourceClient.replaceFile.mockResolvedValue({
      status: 'replaced',
      file: {
        externalId: 'cf-1',
        displayName: 'doc.pdf',
        fileName: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        modifiedAt: new Date('2026-04-02T12:00:00Z'),
        downloadUrl: 'http://x',
      },
    });
    // Newer batch already claimed source_file between check and update.
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 0 } as any);

    await service.writeBack('bf-1');

    // Method must return cleanly — no throw.
    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledOnce();
  });
});
