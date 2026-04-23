import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Course, Institution } from '@prisma/client';

const {
  mockInstitutionFindUnique,
  mockCourseFindUnique,
  mockCourseUpdate,
} = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockCourseFindUnique: vi.fn(),
  mockCourseUpdate: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: { findUnique: mockInstitutionFindUnique },
    course: {
      findUnique: mockCourseFindUnique,
      update: mockCourseUpdate,
    },
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

function makeInstitution(writebackOptIn = false): Institution {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'U', slug: 'u', sourceType: 'canvas', credentials: {},
    writebackOptIn, syncEnabled: true, syncTime: '02:00',
    lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeCourse(writebackOptIn: boolean | null = null): Course {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    institutionId: '11111111-1111-1111-1111-111111111111',
    canvasCourseId: 'canvas-99',
    canvasTermId: null, name: 'C', courseCode: null,
    writebackOptIn, lastSyncedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

const BASE =
  '/api/v1/access-hub/institutions/11111111-1111-1111-1111-111111111111/courses/canvas-99/settings';

describe('GET course remediation settings (TASK-06 / VALIDATION-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution(false));
    mockCourseFindUnique.mockResolvedValue(makeCourse(null));
  });

  it('returns 401 without auth', async () => {
    await request(app).get(BASE).expect(401);
  });

  it('returns 200 with correct shape when course override is null (falls back to institution)', async () => {
    const res = await request(app).get(BASE).set(auth()).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      canvas_course_id: 'canvas-99',
      remediation_delivery: {
        mode: 'opt_in',
        effective_writeback_opt_in: false,
        course_writeback_opt_in: null,
        institution_writeback_opt_in: false,
      },
    });
  });

  it('returns mode=opt_out when institution has writebackOptIn=true and course override is null', async () => {
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution(true));
    const res = await request(app).get(BASE).set(auth()).expect(200);
    const rd = res.body.data.remediation_delivery;
    expect(rd.mode).toBe('opt_out');
    expect(rd.effective_writeback_opt_in).toBe(true);
    expect(rd.institution_writeback_opt_in).toBe(true);
  });

  it('course override wins over institution when set', async () => {
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution(true));
    mockCourseFindUnique.mockResolvedValue(makeCourse(false));
    const res = await request(app).get(BASE).set(auth()).expect(200);
    const rd = res.body.data.remediation_delivery;
    expect(rd.mode).toBe('opt_in');
    expect(rd.effective_writeback_opt_in).toBe(false);
    expect(rd.course_writeback_opt_in).toBe(false);
    expect(rd.institution_writeback_opt_in).toBe(true);
  });

  it('mode invariant: mode===opt_out iff effective_writeback_opt_in===true', async () => {
    const res = await request(app).get(BASE).set(auth()).expect(200);
    const rd = res.body.data.remediation_delivery;
    expect(rd.mode === 'opt_out').toBe(rd.effective_writeback_opt_in);
  });

  it('returns 404 for unknown institution', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    await request(app).get(BASE).set(auth()).expect(404);
  });
});

describe('PATCH course remediation settings (TASK-06 / VALIDATION-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution(false));
    mockCourseFindUnique.mockResolvedValue(makeCourse(null));
  });

  it('returns 401 without auth', async () => {
    await request(app).patch(BASE).send({ remediation_delivery: { mode: 'opt_out' } }).expect(401);
  });

  it('PATCH opt_out sets writebackOptIn=true and returns updated settings', async () => {
    mockCourseUpdate.mockResolvedValue(makeCourse(true));
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .send({ remediation_delivery: { mode: 'opt_out' } })
      .expect(200);

    expect(mockCourseUpdate).toHaveBeenCalledWith({
      where: { id: '22222222-2222-2222-2222-222222222222' },
      data: { writebackOptIn: true },
    });
    const rd = res.body.data.remediation_delivery;
    expect(rd.mode).toBe('opt_out');
    expect(rd.effective_writeback_opt_in).toBe(true);
    expect(rd.course_writeback_opt_in).toBe(true);
  });

  it('PATCH opt_in sets writebackOptIn=false and returns updated settings', async () => {
    mockCourseUpdate.mockResolvedValue(makeCourse(false));
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .send({ remediation_delivery: { mode: 'opt_in' } })
      .expect(200);

    expect(mockCourseUpdate).toHaveBeenCalledWith({
      where: { id: '22222222-2222-2222-2222-222222222222' },
      data: { writebackOptIn: false },
    });
    const rd = res.body.data.remediation_delivery;
    expect(rd.mode).toBe('opt_in');
    expect(rd.effective_writeback_opt_in).toBe(false);
  });

  it('returns 400 for invalid mode', async () => {
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .send({ remediation_delivery: { mode: 'wrong' } })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(mockCourseUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when remediation_delivery is missing', async () => {
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{ bad json')
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('mode invariant holds after PATCH: mode===opt_out iff effective_writeback_opt_in===true', async () => {
    mockCourseUpdate.mockResolvedValue(makeCourse(true));
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .send({ remediation_delivery: { mode: 'opt_out' } })
      .expect(200);
    const rd = res.body.data.remediation_delivery;
    expect(rd.mode === 'opt_out').toBe(rd.effective_writeback_opt_in);
  });
});
