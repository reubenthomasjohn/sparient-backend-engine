import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Course, Institution } from '@prisma/client';

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

const basic = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

const auth = () => ({
  Authorization: basic(
    process.env.ACCESS_HUB_BASIC_USER ?? 'hubuser',
    process.env.ACCESS_HUB_BASIC_PASSWORD ?? 'hubpass',
  ),
});

const institution: Institution = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'U',
  slug: 'u',
  sourceType: 'canvas',
  credentials: {},
  writebackOptIn: false,
  syncEnabled: true,
  syncTime: '02:00',
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const course: Course = {
  id: '22222222-2222-2222-2222-222222222222',
  institutionId: institution.id,
  canvasCourseId: 'canvas-99',
  canvasTermId: null,
  name: 'C',
  courseCode: null,
  writebackOptIn: null,
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('GET course dashboard (TASK-04 / VALIDATION-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(institution);
    mockCourseFindUnique.mockResolvedValue(course);
  });

  it('returns 401 without auth', async () => {
    mockSourceFileFindMany.mockResolvedValue([]);
    await request(app)
      .get(
        `/api/v1/access-hub/institutions/${institution.id}/courses/${course.canvasCourseId}/dashboard`,
      )
      .expect(401);
  });

  it('returns 200 with required data shape for empty course', async () => {
    mockSourceFileFindMany.mockResolvedValue([]);
    const res = await request(app)
      .get(
        `/api/v1/access-hub/institutions/${institution.id}/courses/${course.canvasCourseId}/dashboard`,
      )
      .set(auth())
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      canvas_course_id: course.canvasCourseId,
      issues: {
        total_reported: 0,
        resolved: 0,
        still_open: 0,
      },
      counts: {
        total_files: 0,
        files_scanned: 0,
        files_with_issues: 0,
        awaiting_review: 0,
        fixed_by_access_hub: 0,
        files_replaced_in_canvas: 0,
      },
      high_impact_files: [],
      issues_by_file_type: [],
      issue_categories: [],
    });
  });

  it('loads source files for the resolved course only', async () => {
    mockSourceFileFindMany.mockResolvedValue([]);
    await request(app)
      .get(
        `/api/v1/access-hub/institutions/${institution.id}/courses/${course.canvasCourseId}/dashboard`,
      )
      .set(auth())
      .expect(200);

    expect(mockSourceFileFindMany).toHaveBeenCalledWith({
      where: { courseId: course.id },
      include: {
        batchFiles: {
          include: { issueCategories: true },
        },
      },
    });
  });
});
