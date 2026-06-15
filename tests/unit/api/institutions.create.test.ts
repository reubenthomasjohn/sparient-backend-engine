import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { prismaMock } from '../../setup';

// Mock the bucket service so no real S3 is touched; assert/inject failures on it.
vi.mock('../../../src/services/storage/InstitutionBucketService', () => ({
  provisionInstitutionBucket: vi.fn(),
}));

import app from '../../../src/app';
import { provisionInstitutionBucket } from '../../../src/services/storage/InstitutionBucketService';

const URL = '/api/v1/institutions';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Acme University',
    slug: 'acme',
    sourceType: 'canvas',
    credentials: { domain: 'acme.instructure.com', account_id: '1', api_token: 'tok' },
    ...overrides,
  };
}

// What prisma.institution.create returns (PUBLIC select — no credentials).
function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst-1',
    name: 'Acme University',
    slug: 'acme',
    sourceType: 'canvas',
    writebackOptIn: false,
    s3Bucket: null,
    syncEnabled: true,
    syncTime: '02:00',
    syncConfig: null,
    lastSyncedAt: null,
    createdAt: new Date('2026-06-15T00:00:00Z'),
    updatedAt: new Date('2026-06-15T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(provisionInstitutionBucket).mockResolvedValue('sparient-inst-1');
});

describe('POST /api/v1/institutions', () => {
  it('201s, creates the row, provisions the bucket, and never returns credentials', async () => {
    prismaMock.institution.create.mockResolvedValue(createdRow() as any);

    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('inst-1');
    expect(res.body.data).not.toHaveProperty('credentials');
    expect(provisionInstitutionBucket).toHaveBeenCalledWith('inst-1');
  });

  it('400s on a missing required field and never touches the DB', async () => {
    const res = await request(app).post(URL).send(validBody({ slug: undefined }));

    expect(res.status).toBe(400);
    expect(prismaMock.institution.create).not.toHaveBeenCalled();
    expect(provisionInstitutionBucket).not.toHaveBeenCalled();
  });

  it('400s on a non-canvas sourceType (sharepoint not yet supported)', async () => {
    const res = await request(app).post(URL).send(validBody({ sourceType: 'sharepoint' }));

    expect(res.status).toBe(400);
    expect(prismaMock.institution.create).not.toHaveBeenCalled();
  });

  it('400s on an invalid slug (uppercase/spaces)', async () => {
    const res = await request(app).post(URL).send(validBody({ slug: 'Acme U' }));

    expect(res.status).toBe(400);
    expect(prismaMock.institution.create).not.toHaveBeenCalled();
  });

  it('409s on a duplicate slug (Prisma P2002) without provisioning', async () => {
    prismaMock.institution.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(409);
    expect(provisionInstitutionBucket).not.toHaveBeenCalled();
  });

  it('502s and rolls back the row when provisioning fails', async () => {
    prismaMock.institution.create.mockResolvedValue(createdRow() as any);
    prismaMock.institution.delete.mockResolvedValue(createdRow() as any);
    vi.mocked(provisionInstitutionBucket).mockRejectedValue(new Error('S3 down'));

    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(502);
    expect(prismaMock.institution.delete).toHaveBeenCalledWith({ where: { id: 'inst-1' } });
  });
});
