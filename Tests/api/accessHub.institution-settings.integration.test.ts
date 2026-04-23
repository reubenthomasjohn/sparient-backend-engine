import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Institution } from '@prisma/client';
import { buildInstitutionSettingsData } from '@/services/accessHub/institutionSettings';
import { effectiveWritebackOptIn } from '@/services/accessHub/domainDerivations';

const {
  mockInstitutionFindUnique,
  mockInstitutionUpdate,
} = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockInstitutionUpdate: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: {
      findUnique: mockInstitutionFindUnique,
      update: mockInstitutionUpdate,
    },
    course: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    batch: { findMany: vi.fn().mockResolvedValue([]) },
    sourceFile: { findMany: vi.fn().mockResolvedValue([]) },
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
const BASE = `/api/v1/access-hub/institutions/${INST_ID}/settings`;

function makeInstitution(overrides: Partial<Institution> = {}): Institution {
  return {
    id: INST_ID, name: 'Test University', slug: 'test-u',
    sourceType: 'canvas', credentials: {},
    writebackOptIn: false, syncEnabled: true, syncTime: '02:00',
    lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('GET /institutions/:id/settings (TASK-11 / VALIDATION-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution());
  });

  it('returns 401 without auth', async () => {
    await request(app).get(BASE).expect(401);
  });

  it('returns 404 for unknown institution', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    await request(app).get(BASE).set(auth()).expect(404);
  });

  it('returns 200 with correct shape when writebackOptIn is false (opt_in)', async () => {
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution({ writebackOptIn: false }));

    const res = await request(app).get(BASE).set(auth()).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      institution_id: INST_ID,
      remediation_delivery: { mode: 'opt_in', writeback_opt_in: false },
    });
  });

  it('returns 200 with opt_out when writebackOptIn is true', async () => {
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution({ writebackOptIn: true }));

    const res = await request(app).get(BASE).set(auth()).expect(200);

    expect(res.body.data).toEqual({
      institution_id: INST_ID,
      remediation_delivery: { mode: 'opt_out', writeback_opt_in: true },
    });
  });

  it('enforces mode invariant on GET: opt_out iff writeback_opt_in true', async () => {
    for (const writebackOptIn of [false, true]) {
      mockInstitutionFindUnique.mockResolvedValue(makeInstitution({ writebackOptIn }));
      const res = await request(app).get(BASE).set(auth()).expect(200);
      const { mode, writeback_opt_in } = res.body.data.remediation_delivery;
      expect(mode === 'opt_out').toBe(writeback_opt_in);
    }
  });
});

describe('PATCH /institutions/:id/settings (TASK-11 / VALIDATION-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(makeInstitution());
    mockInstitutionUpdate.mockResolvedValue(makeInstitution({ writebackOptIn: false }));
  });

  it('returns 401 without auth', async () => {
    await request(app)
      .patch(BASE)
      .send({ remediation_delivery: { mode: 'opt_in' } })
      .expect(401);
  });

  it('returns 404 for unknown institution', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    await request(app)
      .patch(BASE)
      .set(auth())
      .send({ remediation_delivery: { mode: 'opt_in' } })
      .expect(404);
  });

  it('PATCH opt_out sets writebackOptIn = true and returns opt_out', async () => {
    mockInstitutionUpdate.mockResolvedValue(makeInstitution({ writebackOptIn: true }));

    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send({ remediation_delivery: { mode: 'opt_out' } })
      .expect(200);

    expect(mockInstitutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INST_ID },
        data: { writebackOptIn: true },
      }),
    );
    expect(res.body.data.remediation_delivery.mode).toBe('opt_out');
    expect(res.body.data.remediation_delivery.writeback_opt_in).toBe(true);
  });

  it('PATCH opt_in sets writebackOptIn = false and returns opt_in', async () => {
    mockInstitutionUpdate.mockResolvedValue(makeInstitution({ writebackOptIn: false }));

    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send({ remediation_delivery: { mode: 'opt_in' } })
      .expect(200);

    expect(mockInstitutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INST_ID },
        data: { writebackOptIn: false },
      }),
    );
    expect(res.body.data.remediation_delivery.mode).toBe('opt_in');
    expect(res.body.data.remediation_delivery.writeback_opt_in).toBe(false);
  });

  it('enforces mode invariant on PATCH: opt_out iff writeback_opt_in true', async () => {
    for (const [mode, expectedWriteback] of [['opt_in', false], ['opt_out', true]] as const) {
      mockInstitutionUpdate.mockResolvedValue(makeInstitution({ writebackOptIn: expectedWriteback }));
      const res = await request(app)
        .patch(BASE)
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({ remediation_delivery: { mode } })
        .expect(200);
      const { mode: retMode, writeback_opt_in } = res.body.data.remediation_delivery;
      expect(retMode === 'opt_out').toBe(writeback_opt_in);
    }
  });

  it('returns 400 for invalid mode', async () => {
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send({ remediation_delivery: { mode: 'invalid' } })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for missing remediation_delivery', async () => {
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for missing mode field', async () => {
    const res = await request(app)
      .patch(BASE)
      .set(auth())
      .set('Content-Type', 'application/json')
      .send({ remediation_delivery: {} })
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

  it('institution default affects effective course policy when course override is null', () => {
    // VALIDATION-11 deliverable: "institution default affects effective course policy when
    // course override null".
    // effectiveWritebackOptIn({ institutionWritebackOptIn: X, courseWritebackOptIn: null }) === X
    for (const instOptIn of [false, true]) {
      const instData = buildInstitutionSettingsData({ id: 'i', writebackOptIn: instOptIn });
      const effective = effectiveWritebackOptIn({
        institutionWritebackOptIn: instOptIn,
        courseWritebackOptIn: null,
      });
      // With no course override, effective equals institution default
      expect(effective).toBe(instOptIn);
      // Mode invariant holds for institution settings too
      expect(instData.remediation_delivery.mode === 'opt_out').toBe(instOptIn);
    }
  });
});
