import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { prismaMock } from '../../setup';

// The replace path enqueues via writebackQueue; mock the module so no real queue is
// touched and we can assert/inject failures on .send.
vi.mock('../../../src/queue', () => ({
  writebackQueue: { send: vi.fn() },
}));

import app from '../../../src/app';
import { writebackQueue } from '../../../src/queue';

const SINGLE = '/api/v1/institutions/inst-1/courses/canvas-course-9/files/file-1/replace';
const BULK = '/api/v1/institutions/inst-1/courses/canvas-course-9/files/replace';
const T1 = new Date('2026-04-01T00:00:00Z');

function eligibleBatchFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bf-1',
    connectivoState: 'completed',
    remediatedS3Key: 'remediated/bf-1.pdf',
    remediatedS3Bucket: 'sparient-inst-1',
    sourceModifiedAt: T1,
    ...overrides,
  };
}

// Resolve institution + course (the route's pre-step). Tests override per case.
function resolveOk() {
  prismaMock.institution.findUnique.mockResolvedValue({ id: 'inst-1' } as any);
  prismaMock.course.findUnique.mockResolvedValue({ id: 'course-1' } as any);
}

beforeEach(() => {
  vi.mocked(writebackQueue.send).mockResolvedValue(undefined);
  prismaMock.sourceFile.updateMany.mockResolvedValue({ count: 1 } as any);
});

describe('POST /institutions/:id/courses/:canvasCourseId/files/:canvasFileId/replace', () => {
  it('202s and enqueues the latest eligible batch on the happy path', async () => {
    resolveOk();
    prismaMock.sourceFile.findUnique.mockImplementation((args: any) =>
      args.where.id
        ? Promise.resolve({ id: 'sf-1', batchedModifiedAt: T1, writebackState: null } as any)
        : Promise.resolve({ id: 'sf-1' } as any),
    );
    prismaMock.batchFile.findFirst.mockResolvedValue(eligibleBatchFile() as any);

    const res = await request(app).post(SINGLE);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, status: 'queued', canvasFileId: 'file-1' });
    expect(writebackQueue.send).toHaveBeenCalledWith({
      batchFileId: 'bf-1',
      ignoreOptIn: true,
      sourceFileId: 'sf-1',
    });
  });

  it('404s when the institution does not exist', async () => {
    prismaMock.institution.findUnique.mockResolvedValue(null);
    const res = await request(app).post(SINGLE);
    expect(res.status).toBe(404);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('404s when the course is not synced for that institution', async () => {
    prismaMock.institution.findUnique.mockResolvedValue({ id: 'inst-1' } as any);
    prismaMock.course.findUnique.mockResolvedValue(null);
    const res = await request(app).post(SINGLE);
    expect(res.status).toBe(404);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('404s when the file is not discovered in that course', async () => {
    resolveOk();
    prismaMock.sourceFile.findUnique.mockResolvedValue(null); // route's canvasFileId lookup
    const res = await request(app).post(SINGLE);
    expect(res.status).toBe(404);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('409s when there is no completed remediation', async () => {
    resolveOk();
    prismaMock.sourceFile.findUnique.mockImplementation((args: any) =>
      args.where.id
        ? Promise.resolve({ id: 'sf-1', batchedModifiedAt: null, writebackState: null } as any)
        : Promise.resolve({ id: 'sf-1' } as any),
    );
    const res = await request(app).post(SINGLE);
    expect(res.status).toBe(409);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('409s when the completed batch has no remediated output', async () => {
    resolveOk();
    prismaMock.sourceFile.findUnique.mockImplementation((args: any) =>
      args.where.id
        ? Promise.resolve({ id: 'sf-1', batchedModifiedAt: T1, writebackState: null } as any)
        : Promise.resolve({ id: 'sf-1' } as any),
    );
    prismaMock.batchFile.findFirst.mockResolvedValue(
      eligibleBatchFile({ remediatedS3Key: null }) as any,
    );
    const res = await request(app).post(SINGLE);
    expect(res.status).toBe(409);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('502s and rolls back the queued stamp when the enqueue fails', async () => {
    resolveOk();
    prismaMock.sourceFile.findUnique.mockImplementation((args: any) =>
      args.where.id
        ? Promise.resolve({ id: 'sf-1', batchedModifiedAt: T1, writebackState: 'failed' } as any)
        : Promise.resolve({ id: 'sf-1' } as any),
    );
    prismaMock.batchFile.findFirst.mockResolvedValue(eligibleBatchFile() as any);
    vi.mocked(writebackQueue.send).mockRejectedValue(new Error('SQS down'));

    const res = await request(app).post(SINGLE);

    expect(res.status).toBe(502);
    // Two updateMany calls: the optimistic 'queued' stamp, then the rollback to 'failed'.
    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.sourceFile.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'sf-1', writebackState: 'queued' },
      data: { writebackState: 'failed' },
    });
  });
});

describe('POST /institutions/:id/courses/:canvasCourseId/files/replace (bulk)', () => {
  it('202s with partial success: accepts eligible, rejects missing + not-remediated', async () => {
    resolveOk();
    // Route resolves the explicit list -> sf-1, sf-2 exist; "missing" does not.
    prismaMock.sourceFile.findMany.mockResolvedValue([
      { id: 'sf-1', canvasFileId: 'file-1' },
      { id: 'sf-2', canvasFileId: 'file-2' },
    ] as any);
    prismaMock.sourceFile.findUnique.mockImplementation((args: any) => {
      if (args.where.id === 'sf-1')
        return Promise.resolve({ id: 'sf-1', batchedModifiedAt: T1, writebackState: null } as any);
      if (args.where.id === 'sf-2')
        return Promise.resolve({ id: 'sf-2', batchedModifiedAt: null, writebackState: null } as any);
      return Promise.resolve(null);
    });
    prismaMock.batchFile.findFirst.mockResolvedValue(eligibleBatchFile() as any);

    const res = await request(app)
      .post(BULK)
      .send({ canvasFileIds: ['file-1', 'file-2', 'missing'] });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([{ canvasFileId: 'file-1' }]);
    expect(res.body.rejected).toEqual(
      expect.arrayContaining([
        { canvasFileId: 'file-2', code: 'no_completed_remediation', reason: expect.any(String) },
        { canvasFileId: 'missing', code: 'not_found', reason: expect.any(String) },
      ]),
    );
    expect(writebackQueue.send).toHaveBeenCalledTimes(1);
  });

  it('422s when every file is rejected (nothing queued)', async () => {
    resolveOk();
    prismaMock.sourceFile.findMany.mockResolvedValue([] as any);

    const res = await request(app).post(BULK).send({ canvasFileIds: ['missing'] });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.accepted).toEqual([]);
    expect(res.body.rejected).toEqual([
      { canvasFileId: 'missing', code: 'not_found', reason: expect.any(String) },
    ]);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('400s when the explicit list exceeds the per-call cap', async () => {
    resolveOk();
    const ids = Array.from({ length: 101 }, (_, i) => `f-${i}`);
    const res = await request(app).post(BULK).send({ canvasFileIds: ids });
    expect(res.status).toBe(400);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('replaces every eligible file when no list is given', async () => {
    resolveOk();
    prismaMock.sourceFile.findMany.mockResolvedValue([
      { id: 'sf-1', canvasFileId: 'file-1' },
    ] as any);
    prismaMock.sourceFile.findUnique.mockResolvedValue({
      id: 'sf-1',
      batchedModifiedAt: T1,
      writebackState: null,
    } as any);
    prismaMock.batchFile.findFirst.mockResolvedValue(eligibleBatchFile() as any);

    const res = await request(app).post(BULK).send({});

    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([{ canvasFileId: 'file-1' }]);
    expect(writebackQueue.send).toHaveBeenCalledTimes(1);
  });

  it('400s when "all eligible" exceeds the per-call cap', async () => {
    resolveOk();
    prismaMock.sourceFile.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ id: `sf-${i}`, canvasFileId: `f-${i}` })) as any,
    );
    const res = await request(app).post(BULK).send({});
    expect(res.status).toBe(400);
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });
});
