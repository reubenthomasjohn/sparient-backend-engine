import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { prismaMock } from '../../setup';

// The route enqueues via writebackQueue; mock the module so no real SQS/in-memory
// queue is touched and we can assert/inject failures on .send.
vi.mock('../../../src/queue', () => ({
  writebackQueue: { send: vi.fn() },
}));

import app from '../../../src/app';
import { writebackQueue } from '../../../src/queue';

const URL = '/api/v1/batches/batch-1/files/bf-1/replace';
const T1 = new Date('2026-04-01T00:00:00Z');

// A batch_file that passes every pre-check: terminal connectivoState, remediated
// S3 location present, and sourceModifiedAt == sourceFile.batchedModifiedAt.
function eligibleBatchFile(overrides: Record<string, unknown> = {}) {
  return {
    connectivoState: 'completed',
    remediatedS3Key: 'remediated/bf-1.pdf',
    remediatedS3Bucket: 'sparient-inst-1',
    sourceModifiedAt: T1,
    sourceFileId: 'sf-1',
    sourceFile: { batchedModifiedAt: T1, writebackState: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(writebackQueue.send).mockResolvedValue(undefined);
});

describe('POST /api/v1/batches/:batchId/files/:batchFileId/replace', () => {
  it('202s, stamps queued, and enqueues with ignoreOptIn + sourceFileId on the happy path', async () => {
    prismaMock.batchFile.findFirst.mockResolvedValue(eligibleBatchFile() as any);
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 } as any);

    const res = await request(app).post(URL);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, status: 'queued', batchFileId: 'bf-1' });
    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledWith({
      where: { id: 'sf-1', batchedModifiedAt: T1 },
      data: { writebackState: 'queued' },
    });
    expect(writebackQueue.send).toHaveBeenCalledWith({
      batchFileId: 'bf-1',
      ignoreOptIn: true,
      sourceFileId: 'sf-1',
    });
  });

  it('404s when the batch_file does not exist for that batch', async () => {
    prismaMock.batchFile.findFirst.mockResolvedValue(null);

    const res = await request(app).post(URL);

    expect(res.status).toBe(404);
    expect(writebackQueue.send).not.toHaveBeenCalled();
    expect(prismaMock.sourceFile.updateMany).not.toHaveBeenCalled();
  });

  it('409s when connectivoState is not a completed terminal state', async () => {
    prismaMock.batchFile.findFirst.mockResolvedValue(
      eligibleBatchFile({ connectivoState: 'failed' }) as any,
    );

    const res = await request(app).post(URL);

    expect(res.status).toBe(409);
    expect(writebackQueue.send).not.toHaveBeenCalled();
    expect(prismaMock.sourceFile.updateMany).not.toHaveBeenCalled();
  });

  it('409s when there is no remediated S3 output', async () => {
    prismaMock.batchFile.findFirst.mockResolvedValue(
      eligibleBatchFile({ remediatedS3Key: null }) as any,
    );

    const res = await request(app).post(URL);

    expect(res.status).toBe(409);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('409s when a newer batch has superseded the file (pre-check)', async () => {
    prismaMock.batchFile.findFirst.mockResolvedValue(
      eligibleBatchFile({ sourceFile: { batchedModifiedAt: new Date('2026-04-05'), writebackState: null } }) as any,
    );

    const res = await request(app).post(URL);

    expect(res.status).toBe(409);
    expect(writebackQueue.send).not.toHaveBeenCalled();
    expect(prismaMock.sourceFile.updateMany).not.toHaveBeenCalled();
  });

  it('409s and does not enqueue when the guarded stamp races a newer batch (count=0)', async () => {
    prismaMock.batchFile.findFirst.mockResolvedValue(eligibleBatchFile() as any);
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 0 } as any);

    const res = await request(app).post(URL);

    expect(res.status).toBe(409);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('rolls back the queued stamp and 500s when the queue enqueue fails', async () => {
    prismaMock.batchFile.findFirst.mockResolvedValue(
      eligibleBatchFile({ sourceFile: { batchedModifiedAt: T1, writebackState: 'written' } }) as any,
    );
    prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 } as any);
    vi.mocked(writebackQueue.send).mockRejectedValue(new Error('SQS down'));

    const res = await request(app).post(URL);

    expect(res.status).toBe(500);
    expect(writebackQueue.send).toHaveBeenCalledTimes(1);
    // Two updateMany calls: the optimistic 'queued' stamp, then the rollback to the
    // prior state ('written' here) so the UI doesn't poll a phantom in-flight state.
    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.sourceFile.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'sf-1', writebackState: 'queued' },
      data: { writebackState: 'written' },
    });
  });
});
