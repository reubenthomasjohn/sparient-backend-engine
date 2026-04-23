import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { BatchFile, Course, Institution, SourceFile } from '@prisma/client';

const {
  mockInstitutionFindUnique,
  mockCourseFindUnique,
  mockSourceFileFindUnique,
  mockBatchFileFindUnique,
} = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockCourseFindUnique: vi.fn(),
  mockSourceFileFindUnique: vi.fn(),
  mockBatchFileFindUnique: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: { findUnique: mockInstitutionFindUnique },
    course: { findUnique: mockCourseFindUnique },
    sourceFile: { findUnique: mockSourceFileFindUnique },
    batchFile: { findUnique: mockBatchFileFindUnique },
  },
}));

import app from '@/app';

const basic = (u: string, p: string) =>
  'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const auth = () => ({
  Authorization: basic(
    process.env.ACCESS_HUB_BASIC_USER ?? 'hubuser',
    process.env.ACCESS_HUB_BASIC_PASSWORD ?? 'hubpass',
  ),
});

const INST_ID = '11111111-1111-1111-1111-111111111111';
const COURSE_ID = '22222222-2222-2222-2222-222222222222';
const SF_ID = '33333333-3333-3333-3333-333333333333';
const BF_ID = '44444444-4444-4444-4444-444444444444';
const CANVAS_FILE_ID = 'cf-abc';

const institution: Institution = {
  id: INST_ID, name: 'U', slug: 'u', sourceType: 'canvas', credentials: {},
  writebackOptIn: false, syncEnabled: true, syncTime: '02:00',
  lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

const course: Course = {
  id: COURSE_ID, institutionId: INST_ID, canvasCourseId: 'canvas-99',
  canvasTermId: null, name: 'C', courseCode: null, writebackOptIn: null,
  lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

const T = new Date('2026-01-01T00:00:00Z');

function makeSF(overrides: Partial<SourceFile> = {}): SourceFile & { batchFiles: { id: string }[] } {
  return {
    id: SF_ID,
    courseId: COURSE_ID,
    canvasFileId: CANVAS_FILE_ID,
    displayName: 'Doc.pdf',
    fileName: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: null,
    discoveredModifiedAt: T,
    s3SourceKey: 'k',
    s3SourceBucket: 'b',
    s3SourceModifiedAt: T,
    batchedModifiedAt: T,
    lastOutcome: 'completed',
    lastFailureReason: null,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    writebackState: null,
    lastWritebackModifiedAt: null,
    reviewAcknowledged: false,
    createdAt: T,
    updatedAt: T,
    ...overrides,
    batchFiles: [{ id: BF_ID }],
  };
}

function makeBF(overrides: Partial<BatchFile> = {}): BatchFile {
  return {
    id: BF_ID,
    batchId: 'b1',
    sourceFileId: SF_ID,
    canvasFileId: CANVAS_FILE_ID,
    s3SourceKey: 'src/key',
    sourceModifiedAt: T,
    connectivoState: null,
    qualityLabel: null,
    remediatedS3Key: 'remediated/key.pdf',
    remediatedS3Bucket: 'bkt',
    totalPages: null,
    processingTimeSecs: null,
    verapdfErrors: null,
    verapdfWarnings: null,
    errorMessage: null,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

const BASE = `/api/v1/access-hub/institutions/${INST_ID}/courses/canvas-99/files/${CANVAS_FILE_ID}/replace`;

describe('POST course file replace (TASK-07 / VALIDATION-07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(institution);
    mockCourseFindUnique.mockResolvedValue(course);
    mockSourceFileFindUnique.mockResolvedValue(makeSF());
    mockBatchFileFindUnique.mockResolvedValue(makeBF());
  });

  it('returns 401 without auth', async () => {
    await request(app).post(BASE).send({ batch_file_id: BF_ID }).expect(401);
  });

  it('returns 202 with request_id, status=queued, message on success', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(202);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      request_id: expect.any(String),
      status: 'queued',
      message: expect.any(String),
    });
    // request_id must be a UUID
    expect(res.body.data.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('returns 400 when batch_file_id is missing', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockSourceFileFindUnique).not.toHaveBeenCalled();
  });

  it('returns 400 when batch_file_id is not a UUID', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: 'not-a-uuid' })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{ bad json')
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when source file not found for canvas_file_id', async () => {
    mockSourceFileFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when batch_file not found', async () => {
    mockBatchFileFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when batch_file.sourceFileId does not match sourceFile.id', async () => {
    mockBatchFileFindUnique.mockResolvedValue(
      makeBF({ sourceFileId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    );
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when batch_file.canvasFileId does not match path canvas_file_id', async () => {
    mockBatchFileFindUnique.mockResolvedValue(
      makeBF({ canvasFileId: 'different-canvas-file' }),
    );
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when remediatedS3Key is null (no artifact)', async () => {
    mockBatchFileFindUnique.mockResolvedValue(
      makeBF({ remediatedS3Key: null }),
    );
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toMatch(/no remediated artifact/i);
  });

  it('returns 400 when remediatedS3Key is empty string', async () => {
    mockBatchFileFindUnique.mockResolvedValue(
      makeBF({ remediatedS3Key: '   ' }),
    );
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 409 when file pipeline is in_flight and writeback not started', async () => {
    // in_flight: batched === s3Source, lastOutcome === null, writebackState === null
    mockSourceFileFindUnique.mockResolvedValue(
      makeSF({
        s3SourceModifiedAt: T,
        batchedModifiedAt: T,
        lastOutcome: null,
        writebackState: null,
      }),
    );
    const res = await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 for unknown institution', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(404);
  });

  it('passes correct sourceFile lookup using course_id + canvas_file_id composite', async () => {
    await request(app)
      .post(BASE)
      .set(auth())
      .send({ batch_file_id: BF_ID })
      .expect(202);

    expect(mockSourceFileFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          courseId_canvasFileId: {
            courseId: COURSE_ID,
            canvasFileId: CANVAS_FILE_ID,
          },
        },
      }),
    );
    expect(mockBatchFileFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: BF_ID } }),
    );
  });
});
