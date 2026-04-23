import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Batch, Course, Institution, SourceFile } from '@prisma/client';

const {
  mockInstitutionFindUnique,
  mockCourseCount,
  mockCourseFindMany,
  mockBatchFindMany,
  mockSourceFileFindMany,
} = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockCourseCount: vi.fn(),
  mockCourseFindMany: vi.fn(),
  mockBatchFindMany: vi.fn(),
  mockSourceFileFindMany: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: { findUnique: mockInstitutionFindUnique },
    course: { count: mockCourseCount, findMany: mockCourseFindMany },
    batch: { findMany: mockBatchFindMany },
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

const INST_ID = '11111111-1111-1111-1111-111111111111';
const BASE = `/api/v1/access-hub/institutions/${INST_ID}/courses`;

const institution: Institution = {
  id: INST_ID, name: 'Test University', slug: 'test-u', sourceType: 'canvas',
  credentials: {}, writebackOptIn: false, syncEnabled: true, syncTime: '02:00',
  lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

const T = new Date('2026-01-15T10:00:00Z');

function makeCourse(id: string, overrides: Partial<Course> = {}): Pick<Course, 'id' | 'canvasCourseId' | 'name' | 'courseCode' | 'institutionId'> {
  return {
    id,
    canvasCourseId: `canvas-${id}`,
    name: `Course ${id}`,
    courseCode: `CODE-${id}`,
    institutionId: INST_ID,
    ...overrides,
  };
}

function makeBatch(courseId: string, overrides: Partial<Batch> = {}): Partial<Batch> {
  return {
    courseId, isInitialSync: false, status: 'completed',
    createdAt: T, completedAt: T, totalIssuesFound: 0,
    ...overrides,
  };
}

function makeSF(courseId: string, overrides: Partial<Pick<SourceFile, 'courseId' | 'lastOutcome' | 'reviewAcknowledged'>> = {}): Pick<SourceFile, 'courseId' | 'lastOutcome' | 'reviewAcknowledged'> {
  return { courseId, lastOutcome: 'completed', reviewAcknowledged: false, ...overrides };
}

describe('GET admin scanned courses (TASK-09 / VALIDATION-09)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(institution);
    mockCourseCount.mockResolvedValue(0);
    mockCourseFindMany.mockResolvedValue([]);
    mockBatchFindMany.mockResolvedValue([]);
    mockSourceFileFindMany.mockResolvedValue([]);
  });

  it('returns 401 without auth', async () => {
    await request(app).get(BASE).expect(401);
  });

  it('returns 200 with empty list and correct envelope', async () => {
    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      items: [],
      page: { number: 1, size: 0, total_items: 0 },
    });
  });

  it('returns 404 for unknown institution', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    await request(app).get(BASE).set(auth()).expect(404);
  });

  it('returns 400 for invalid page param', async () => {
    const res = await request(app)
      .get(`${BASE}?page=0`)
      .set(auth())
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for page_size > 100', async () => {
    const res = await request(app)
      .get(`${BASE}?page_size=200`)
      .set(auth())
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns items with required fields and no forbidden keys', async () => {
    const course = makeCourse('c1');
    mockCourseCount.mockResolvedValue(1);
    mockCourseFindMany.mockResolvedValue([course]);
    mockBatchFindMany.mockResolvedValue([
      makeBatch('c1', { isInitialSync: true, status: 'completed', completedAt: T }),
    ]);
    mockSourceFileFindMany.mockResolvedValue([makeSF('c1')]);

    const res = await request(app).get(BASE).set(auth()).expect(200);
    const item = res.body.data.items[0];

    expect(item).toMatchObject({
      canvas_course_id: 'canvas-c1',
      course_name: 'Course c1',
      course_code: 'CODE-c1',
      account_name: institution.name,
      institution_id: INST_ID,
      counts: {
        errors: expect.any(Number),
        suggestions: 0,
        content_scanned: expect.any(Number),
        content_fixed: expect.any(Number),
        content_resolved: expect.any(Number),
        files_scanned: expect.any(Number),
      },
    });
    // Pagination metadata
    expect(res.body.data.page).toMatchObject({ number: 1, total_items: 1 });

    // Forbidden fields
    const json = JSON.stringify(item);
    expect(json).not.toContain('total_students');
    expect(json).not.toContain('enrollment');
    expect(json).not.toContain('score_percent');
  });

  it('initial_scan_at is min createdAt of isInitialSync batches', async () => {
    const c = makeCourse('c1');
    mockCourseCount.mockResolvedValue(1);
    mockCourseFindMany.mockResolvedValue([c]);
    const earlier = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-02-01T00:00:00Z');
    mockBatchFindMany.mockResolvedValue([
      makeBatch('c1', { isInitialSync: true, createdAt: later, completedAt: later, status: 'completed' }),
      makeBatch('c1', { isInitialSync: true, createdAt: earlier, completedAt: earlier, status: 'completed' }),
      makeBatch('c1', { isInitialSync: false, createdAt: new Date('2025-01-01'), status: 'completed', completedAt: new Date('2025-01-01') }),
    ]);
    mockSourceFileFindMany.mockResolvedValue([]);

    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.data.items[0].initial_scan_at).toBe(earlier.toISOString());
  });

  it('last_scanned_at is max completedAt of terminal batches', async () => {
    const c = makeCourse('c1');
    mockCourseCount.mockResolvedValue(1);
    mockCourseFindMany.mockResolvedValue([c]);
    const older = new Date('2026-01-10T00:00:00Z');
    const newer = new Date('2026-03-10T00:00:00Z');
    mockBatchFindMany.mockResolvedValue([
      makeBatch('c1', { status: 'completed', completedAt: older }),
      makeBatch('c1', { status: 'completed_with_warnings', completedAt: newer }),
      makeBatch('c1', { status: 'pending', completedAt: null }),
    ]);
    mockSourceFileFindMany.mockResolvedValue([]);

    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.data.items[0].last_scanned_at).toBe(newer.toISOString());
  });

  it('initial_scan_at and last_scanned_at are null when no relevant batches', async () => {
    const c = makeCourse('c1');
    mockCourseCount.mockResolvedValue(1);
    mockCourseFindMany.mockResolvedValue([c]);
    mockBatchFindMany.mockResolvedValue([
      makeBatch('c1', { isInitialSync: false, status: 'pending', completedAt: null }),
    ]);
    mockSourceFileFindMany.mockResolvedValue([]);

    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.data.items[0].initial_scan_at).toBeNull();
    expect(res.body.data.items[0].last_scanned_at).toBeNull();
  });

  it('counts: content_scanned = files with lastOutcome set', async () => {
    const c = makeCourse('c1');
    mockCourseCount.mockResolvedValue(1);
    mockCourseFindMany.mockResolvedValue([c]);
    mockBatchFindMany.mockResolvedValue([]);
    mockSourceFileFindMany.mockResolvedValue([
      makeSF('c1', { lastOutcome: 'completed' }),
      makeSF('c1', { lastOutcome: 'completed_with_warnings' }),
      makeSF('c1', { lastOutcome: null }),
    ]);

    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.data.items[0].counts.content_scanned).toBe(2);
    expect(res.body.data.items[0].counts.files_scanned).toBe(2);
    expect(res.body.data.items[0].counts.content_fixed).toBe(2);
  });

  it('counts: content_resolved = reviewAcknowledged files', async () => {
    const c = makeCourse('c1');
    mockCourseCount.mockResolvedValue(1);
    mockCourseFindMany.mockResolvedValue([c]);
    mockBatchFindMany.mockResolvedValue([]);
    mockSourceFileFindMany.mockResolvedValue([
      makeSF('c1', { reviewAcknowledged: true }),
      makeSF('c1', { reviewAcknowledged: false }),
    ]);

    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.data.items[0].counts.content_resolved).toBe(1);
  });

  it('counts: errors = sum totalIssuesFound from terminal batches', async () => {
    const c = makeCourse('c1');
    mockCourseCount.mockResolvedValue(1);
    mockCourseFindMany.mockResolvedValue([c]);
    mockBatchFindMany.mockResolvedValue([
      makeBatch('c1', { status: 'completed', totalIssuesFound: 5, completedAt: T }),
      makeBatch('c1', { status: 'completed_with_warnings', totalIssuesFound: 3, completedAt: T }),
      makeBatch('c1', { status: 'pending', totalIssuesFound: 99, completedAt: null }),
    ]);
    mockSourceFileFindMany.mockResolvedValue([]);

    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.data.items[0].counts.errors).toBe(8);
    expect(res.body.data.items[0].counts.suggestions).toBe(0);
  });

  it('passes canvas_term_id to course query', async () => {
    await request(app)
      .get(`${BASE}?canvas_term_id=2026SP`)
      .set(auth())
      .expect(200);
    expect(mockCourseCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ canvasTermId: '2026SP' }) }),
    );
  });

  it('passes q search to course query (name and courseCode OR)', async () => {
    await request(app)
      .get(`${BASE}?q=biology`)
      .set(auth())
      .expect(200);
    expect(mockCourseCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ name: expect.objectContaining({ contains: 'biology' }) }),
            expect.objectContaining({ courseCode: expect.objectContaining({ contains: 'biology' }) }),
          ]),
        }),
      }),
    );
  });

  it('paginates correctly with skip/take', async () => {
    mockCourseCount.mockResolvedValue(15);
    mockCourseFindMany.mockResolvedValue([makeCourse('c5'), makeCourse('c6')]);
    mockBatchFindMany.mockResolvedValue([]);
    mockSourceFileFindMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}?page=3&page_size=5`)
      .set(auth())
      .expect(200);

    expect(res.body.data.page).toMatchObject({ number: 3, size: 2, total_items: 15 });
    expect(mockCourseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 }),
    );
  });

  it('does not query batches/sourceFiles when no courses found', async () => {
    mockCourseCount.mockResolvedValue(0);
    await request(app).get(BASE).set(auth()).expect(200);
    expect(mockBatchFindMany).not.toHaveBeenCalled();
    expect(mockSourceFileFindMany).not.toHaveBeenCalled();
  });

  it('batches and sourceFiles are scoped to page course IDs only', async () => {
    mockCourseCount.mockResolvedValue(2);
    mockCourseFindMany.mockResolvedValue([makeCourse('c1'), makeCourse('c2')]);
    mockBatchFindMany.mockResolvedValue([]);
    mockSourceFileFindMany.mockResolvedValue([]);

    await request(app).get(BASE).set(auth()).expect(200);

    expect(mockBatchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { courseId: { in: ['c1', 'c2'] } } }),
    );
    expect(mockSourceFileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { courseId: { in: ['c1', 'c2'] } } }),
    );
  });
});
