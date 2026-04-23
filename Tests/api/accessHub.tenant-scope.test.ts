import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Course, Institution } from '@prisma/client';

const { mockInstitutionFindUnique, mockCourseFindUnique } = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockCourseFindUnique: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: { findUnique: mockInstitutionFindUnique },
    course: { findUnique: mockCourseFindUnique },
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

const institutionRow: Institution = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Test U',
  slug: 'test-u',
  sourceType: 'canvas',
  credentials: {},
  writebackOptIn: false,
  syncEnabled: true,
  syncTime: '02:00',
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const courseRow: Course = {
  id: '22222222-2222-2222-2222-222222222222',
  institutionId: institutionRow.id,
  canvasCourseId: 'canvas-99',
  canvasTermId: null,
  name: 'Intro',
  courseCode: 'INTRO-101',
  writebackOptIn: null,
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Access Hub tenant and scope (TASK-02 / VALIDATION-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for malformed institution_id UUID', async () => {
    const res = await request(app)
      .get('/api/v1/access-hub/institutions/not-a-uuid/scope')
      .set(auth())
      .expect(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(mockInstitutionFindUnique).not.toHaveBeenCalled();
  });

  it('returns 404 with generic message when institution does not exist', async () => {
    mockInstitutionFindUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .get(
        `/api/v1/access-hub/institutions/${institutionRow.id}/scope`,
      )
      .set(auth())
      .expect(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
    expect(mockInstitutionFindUnique).toHaveBeenCalledWith({
      where: { id: institutionRow.id },
    });
  });

  it('returns institution scope when institution exists', async () => {
    mockInstitutionFindUnique.mockResolvedValueOnce(institutionRow);
    const res = await request(app)
      .get(`/api/v1/access-hub/institutions/${institutionRow.id}/scope`)
      .set(auth())
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      data: { institution_id: institutionRow.id },
    });
  });

  it('returns 404 with same generic message when course is missing for institution', async () => {
    mockInstitutionFindUnique.mockResolvedValueOnce(institutionRow);
    mockCourseFindUnique.mockResolvedValueOnce(null);
    const res = await request(app)
      .get(
        `/api/v1/access-hub/institutions/${institutionRow.id}/courses/${courseRow.canvasCourseId}/scope`,
      )
      .set(auth())
      .expect(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
    expect(mockCourseFindUnique).toHaveBeenCalledWith({
      where: {
        institutionId_canvasCourseId: {
          institutionId: institutionRow.id,
          canvasCourseId: courseRow.canvasCourseId,
        },
      },
    });
  });

  it('resolves course only with composite (institution_id + canvas_course_id)', async () => {
    mockInstitutionFindUnique.mockResolvedValueOnce(institutionRow);
    mockCourseFindUnique.mockResolvedValueOnce(courseRow);
    const res = await request(app)
      .get(
        `/api/v1/access-hub/institutions/${institutionRow.id}/courses/${courseRow.canvasCourseId}/scope`,
      )
      .set(auth())
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        institution_id: institutionRow.id,
        course_id: courseRow.id,
        canvas_course_id: courseRow.canvasCourseId,
      },
    });
  });
});
