import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Institution } from '@prisma/client';

const {
  mockInstitutionFindUnique,
  mockCourseFindMany,
  mockSourceFileFindMany,
} = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockCourseFindMany: vi.fn(),
  mockSourceFileFindMany: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: { findUnique: mockInstitutionFindUnique },
    course: { findMany: mockCourseFindMany },
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

const institution: Institution = {
  id: INST_ID, name: 'U', slug: 'u', sourceType: 'canvas', credentials: {},
  writebackOptIn: false, syncEnabled: true, syncTime: '02:00',
  lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

const BASE = `/api/v1/access-hub/institutions/${INST_ID}/dashboard`;

describe('GET institution dashboard (TASK-08 / VALIDATION-08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(institution);
    mockCourseFindMany.mockResolvedValue([]);
    mockSourceFileFindMany.mockResolvedValue([]);
  });

  it('returns 401 without auth', async () => {
    await request(app).get(BASE).expect(401);
  });

  it('returns 200 with required shape for empty institution', async () => {
    const res = await request(app).get(BASE).set(auth()).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      institution_id: INST_ID,
      scanned_courses: 0,
      issues: { total_reported: 0, resolved: 0, still_open: 0 },
      content_summary: { errors: 0, suggestions: 0, issues_fixed: 0, marked_resolved: 0 },
      file_pipeline: {
        total_files: 0, files_scanned: 0, files_with_issues: 0,
        awaiting_review: 0, fixed_by_access_hub: 0, files_replaced_in_canvas: 0,
      },
      issue_categories: [],
    });
  });

  it('no forbidden keys in response', async () => {
    const res = await request(app).get(BASE).set(auth()).expect(200);
    const json = JSON.stringify(res.body.data);
    expect(json).not.toContain('score_percent');
    expect(json).not.toContain('band');
    expect(json).not.toContain('impact_scorecard');
    expect(json).not.toContain('account_accessibility');
  });

  it('returns 404 for unknown institution', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    const res = await request(app).get(BASE).set(auth()).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('passes canvas_term_id filter to course query', async () => {
    await request(app)
      .get(`${BASE}?canvas_term_id=term-2026`)
      .set(auth())
      .expect(200);

    expect(mockCourseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { institutionId: INST_ID, canvasTermId: 'term-2026' },
      }),
    );
  });

  it('does not pass canvasTermId when query param is absent', async () => {
    await request(app).get(BASE).set(auth()).expect(200);

    expect(mockCourseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { institutionId: INST_ID },
      }),
    );
  });

  it('does not query sourceFiles when no courses found', async () => {
    mockCourseFindMany.mockResolvedValue([]);
    await request(app).get(BASE).set(auth()).expect(200);
    expect(mockSourceFileFindMany).not.toHaveBeenCalled();
  });

  it('queries sourceFiles scoped to returned course IDs', async () => {
    mockCourseFindMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    mockSourceFileFindMany.mockResolvedValue([]);

    await request(app).get(BASE).set(auth()).expect(200);

    expect(mockSourceFileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { courseId: { in: ['c1', 'c2'] } },
        include: { batchFiles: { include: { issueCategories: true } } },
      }),
    );
  });

  it('canvas_term_id narrowing is reflected in course query', async () => {
    // Two terms: only one should be queried
    mockCourseFindMany.mockResolvedValue([{ id: 'c-term1' }]);
    mockSourceFileFindMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`${BASE}?canvas_term_id=2026SP`)
      .set(auth())
      .expect(200);

    // Course findMany restricted to term
    expect(mockCourseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { institutionId: INST_ID, canvasTermId: '2026SP' },
      }),
    );
    // sourceFiles restricted to those course IDs
    expect(mockSourceFileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { courseId: { in: ['c-term1'] } },
      }),
    );
    expect(res.body.success).toBe(true);
  });

  it('empty canvas_term_id string is ignored (treated as absent)', async () => {
    await request(app)
      .get(`${BASE}?canvas_term_id=`)
      .set(auth())
      .expect(200);

    expect(mockCourseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { institutionId: INST_ID },
      }),
    );
  });
});
