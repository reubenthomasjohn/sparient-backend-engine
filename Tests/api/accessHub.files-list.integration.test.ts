import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { BatchFile, Course, FileIssueCategory, Institution, SourceFile } from '@prisma/client';

const {
  mockInstitutionFindUnique,
  mockCourseFindUnique,
  mockSourceFileFindMany,
} = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockCourseFindUnique: vi.fn(),
  mockSourceFileFindMany: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: { findUnique: mockInstitutionFindUnique },
    course: { findUnique: mockCourseFindUnique },
    sourceFile: { findMany: mockSourceFileFindMany },
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

const institution: Institution = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'U', slug: 'u', sourceType: 'canvas', credentials: {},
  writebackOptIn: false, syncEnabled: true, syncTime: '02:00',
  lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
};
const course: Course = {
  id: '22222222-2222-2222-2222-222222222222',
  institutionId: institution.id, canvasCourseId: 'canvas-99',
  canvasTermId: null, name: 'C', courseCode: null,
  writebackOptIn: null, lastSyncedAt: null,
  createdAt: new Date(), updatedAt: new Date(),
};

const BASE = `/api/v1/access-hub/institutions/${institution.id}/courses/${course.canvasCourseId}/files`;

const T = new Date('2026-01-01T00:00:00Z');

function makeSF(
  id: string,
  overrides: Partial<SourceFile> = {},
  batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }> = [],
): SourceFile & { batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }> } {
  return {
    id,
    courseId: course.id,
    canvasFileId: `cf-${id}`,
    displayName: `File ${id}.pdf`,
    fileName: `file-${id}.pdf`,
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
    batchFiles,
  };
}

describe('GET course files list (TASK-05 / VALIDATION-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(institution);
    mockCourseFindUnique.mockResolvedValue(course);
  });

  it('returns 401 without auth', async () => {
    await request(app).get(BASE).expect(401);
  });

  it('returns 200 with empty list and correct envelope shape', async () => {
    mockSourceFileFindMany.mockResolvedValue([]);
    const res = await request(app).get(BASE).set(auth()).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      items: [],
      page: { number: 1, size: 0, total_items: 0 },
    });
  });

  it('returns correct item shape with required fields and no forbidden keys', async () => {
    mockSourceFileFindMany.mockResolvedValue([makeSF('a')]);
    const res = await request(app).get(BASE).set(auth()).expect(200);

    const item = res.body.data.items[0];
    expect(item).toMatchObject({
      source_file_id: expect.any(String),
      canvas_file_id: expect.any(String),
      display_name: expect.any(String),
      file_name: expect.any(String),
      file_type: expect.any(String),
      mime_type: expect.any(String),
      last_updated: expect.any(String),
      open_issues: expect.any(Number),
      review_acknowledged: expect.any(Boolean),
      status: {
        pipeline: expect.any(String),
        summary: expect.any(String),
      },
      canvas_replacement: {
        state: expect.any(String),
      },
    });
    // VALIDATION-05: no comment key
    expect(item).not.toHaveProperty('comment');
    // VALIDATION-01: no forbidden keys
    const allKeys = JSON.stringify(item);
    expect(allKeys).not.toContain('score_percent');
    expect(allKeys).not.toContain('band');
    expect(allKeys).not.toContain('impact_scorecard');
  });

  it('returns 400 for invalid status query param', async () => {
    const res = await request(app)
      .get(`${BASE}?status=invalid`)
      .set(auth())
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for page_size > 100', async () => {
    const res = await request(app)
      .get(`${BASE}?page_size=200`)
      .set(auth())
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 for unknown institution', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    await request(app).get(BASE).set(auth()).expect(404);
  });

  it('paginates correctly', async () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((id) => makeSF(id));
    mockSourceFileFindMany.mockResolvedValue(files);

    const res = await request(app)
      .get(`${BASE}?page=2&page_size=2`)
      .set(auth())
      .expect(200);

    expect(res.body.data.page).toMatchObject({
      number: 2,
      size: 2,
      total_items: 5,
    });
    expect(res.body.data.items).toHaveLength(2);
  });

  it('hide_replaced_in_canvas excludes replaced files', async () => {
    const replaced = makeSF(
      'r',
      { writebackState: 'written', lastOutcome: 'completed' },
      [
        {
          id: 'bf1', batchId: 'b1', sourceFileId: 'r', canvasFileId: 'cf-r',
          s3SourceKey: 'k', sourceModifiedAt: T, connectivoState: null,
          qualityLabel: null, remediatedS3Key: 'key/r.pdf',
          remediatedS3Bucket: 'bkt', totalPages: null, processingTimeSecs: null,
          verapdfErrors: null, verapdfWarnings: null, errorMessage: null,
          createdAt: T, updatedAt: T,
          issueCategories: [],
        },
      ],
    );
    const normal = makeSF('n');
    mockSourceFileFindMany.mockResolvedValue([replaced, normal]);

    // effectiveWriteback=false (institution.writebackOptIn=false, course.writebackOptIn=null)
    // => replaced file shows state=not_applicable, so it won't be excluded even with hide flag
    // To test the exclusion, we need effectiveWriteback=true → override institution
    mockInstitutionFindUnique.mockResolvedValue({ ...institution, writebackOptIn: true });

    const res = await request(app)
      .get(`${BASE}?hide_replaced_in_canvas=true`)
      .set(auth())
      .expect(200);

    const ids = res.body.data.items.map((i: { canvas_file_id: string }) => i.canvas_file_id);
    expect(ids).not.toContain('cf-r');
    expect(ids).toContain('cf-n');
  });

  it('passes q search parameter to DB query', async () => {
    mockSourceFileFindMany.mockResolvedValue([]);
    await request(app).get(`${BASE}?q=hello`).set(auth()).expect(200);

    expect(mockSourceFileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ displayName: expect.objectContaining({ contains: 'hello' }) }),
          ]),
        }),
      }),
    );
  });

  it('status=in_progress filters to pipeline in_progress files', async () => {
    const inFlight = makeSF('if', {
      lastOutcome: null,
      s3SourceModifiedAt: T,
      batchedModifiedAt: T,
    });
    const terminal = makeSF('t', { lastOutcome: 'completed' });
    mockSourceFileFindMany.mockResolvedValue([inFlight, terminal]);

    const res = await request(app)
      .get(`${BASE}?status=in_progress`)
      .set(auth())
      .expect(200);

    expect(res.body.data.page.total_items).toBe(1);
    expect(res.body.data.items[0].status.pipeline).toBe('in_flight');
  });
});
