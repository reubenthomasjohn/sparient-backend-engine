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

// AWS_REGION is stubbed to us-east-2 in setup; INSTITUTION_BUCKET_PREFIX is unset,
// so config falls back to "sparient" → expected bucket "sparient-<slug>".
const EXPECTED_BUCKET = 'sparient-acme';

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
    s3Bucket: EXPECTED_BUCKET,
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
  vi.mocked(provisionInstitutionBucket).mockResolvedValue(EXPECTED_BUCKET);
  // Default: slug is free.
  prismaMock.institution.findUnique.mockResolvedValue(null as any);
});

describe('POST /api/v1/institutions', () => {
  it('201s: provisions the slug-named bucket, stores it, never returns credentials', async () => {
    prismaMock.institution.create.mockResolvedValue(createdRow() as any);

    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('inst-1');
    expect(res.body.data.s3Bucket).toBe(EXPECTED_BUCKET);
    expect(res.body.data).not.toHaveProperty('credentials');

    // Bucket provisioned with the slug-derived name (not an id), before the row write.
    expect(provisionInstitutionBucket).toHaveBeenCalledWith(EXPECTED_BUCKET);
    expect(prismaMock.institution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: 'acme', s3Bucket: EXPECTED_BUCKET }),
      }),
    );
  });

  it('409s on a pre-existing slug, before any provisioning or create', async () => {
    prismaMock.institution.findUnique.mockResolvedValue({ id: 'other' } as any);

    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(409);
    expect(provisionInstitutionBucket).not.toHaveBeenCalled();
    expect(prismaMock.institution.create).not.toHaveBeenCalled();
  });

  it('400s on a missing required field and never touches the DB or S3', async () => {
    const res = await request(app).post(URL).send(validBody({ slug: undefined }));

    expect(res.status).toBe(400);
    expect(prismaMock.institution.findUnique).not.toHaveBeenCalled();
    expect(provisionInstitutionBucket).not.toHaveBeenCalled();
  });

  it('400s on a non-canvas sourceType (sharepoint not yet supported)', async () => {
    const res = await request(app).post(URL).send(validBody({ sourceType: 'sharepoint' }));

    expect(res.status).toBe(400);
    expect(provisionInstitutionBucket).not.toHaveBeenCalled();
  });

  it('400s on an invalid slug (uppercase/spaces)', async () => {
    const res = await request(app).post(URL).send(validBody({ slug: 'Acme U' }));

    expect(res.status).toBe(400);
    expect(provisionInstitutionBucket).not.toHaveBeenCalled();
  });

  it('400s on an over-long slug (would overflow the 63-char bucket name)', async () => {
    const res = await request(app).post(URL).send(validBody({ slug: 'a'.repeat(40) }));

    expect(res.status).toBe(400);
    expect(provisionInstitutionBucket).not.toHaveBeenCalled();
  });

  it('409s on a create-time slug race (Prisma P2002)', async () => {
    prismaMock.institution.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(409);
    // Bucket was provisioned (deterministic) — that's fine, no rollback needed.
    expect(provisionInstitutionBucket).toHaveBeenCalledWith(EXPECTED_BUCKET);
  });

  it('502s when provisioning fails, without creating a row', async () => {
    vi.mocked(provisionInstitutionBucket).mockRejectedValue(new Error('S3 down'));

    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(502);
    expect(prismaMock.institution.create).not.toHaveBeenCalled();
  });
});
