/**
 * Integration tests for HMAC-SHA256 signed auth HTTP layer (TASK-12 / VALIDATION-12).
 *
 * Signing secrets come from vitest.config.ts env vars (no config mock needed):
 *   ACCESS_HUB_SIGNING_SECRETS = {"<INST_ID>":"per-inst-secret-xyz","*":"global-secret-abc"}
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';

// ─── Mocks (hoisted so they are available in vi.mock factories) ───────────────

const { mockInstitutionFindUnique, mockInstitutionUpdate } = vi.hoisted(() => ({
  mockInstitutionFindUnique: vi.fn(),
  mockInstitutionUpdate: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  default: {
    institution: { findUnique: mockInstitutionFindUnique, update: mockInstitutionUpdate },
    course: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    batch: { findMany: vi.fn().mockResolvedValue([]) },
    sourceFile: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import app from '@/app';
import type { Institution } from '@prisma/client';

// ─── Constants (match vitest.config.ts ACCESS_HUB_SIGNING_SECRETS) ────────────

const INST_ID = '11111111-1111-1111-1111-111111111111';
const PER_INST_SECRET = 'per-inst-secret-xyz';
const GLOBAL_SECRET = 'global-secret-abc';

const institution: Institution = {
  id: INST_ID, name: 'Test University', slug: 'test-u', sourceType: 'canvas',
  credentials: {}, writebackOptIn: false, syncEnabled: true, syncTime: '02:00',
  lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

// ─── Signing helpers ──────────────────────────────────────────────────────────

function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function buildCanonical(
  method: string,
  path: string,
  body: Buffer,
  timestamp: number,
  nonce?: string,
): string {
  const parts = [method.toUpperCase(), path, sha256Hex(body), String(timestamp)];
  if (nonce) parts.push(nonce);
  return parts.join('\n');
}

function signRequest(
  method: string,
  path: string,
  body: Buffer,
  secret: string,
  timestampOverride?: number,
  nonce?: string,
): Record<string, string> {
  const ts = timestampOverride ?? Math.floor(Date.now() / 1000);
  const canonical = buildCanonical(method, path, body, ts, nonce);
  const sig = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    'X-Timestamp': String(ts),
    'X-Signature': sig,
  };
  if (nonce) headers['X-Nonce'] = nonce;
  return headers;
}

const basicAuth = () => ({
  Authorization: 'Basic ' + Buffer.from('hubuser:hubpass').toString('base64'),
});

const PING = '/api/v1/access-hub/ping';
const INST_DASHBOARD = `/api/v1/access-hub/institutions/${INST_ID}/dashboard`;
const INST_SETTINGS = `/api/v1/access-hub/institutions/${INST_ID}/settings`;
const INST_FILES = `/api/v1/access-hub/institutions/${INST_ID}/files`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Signed auth HTTP layer (TASK-12 / VALIDATION-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstitutionFindUnique.mockResolvedValue(institution);
    mockInstitutionUpdate.mockResolvedValue({ ...institution, writebackOptIn: false });
  });

  // ── Basic auth backward compat ────────────────────────────────────────────

  it('Basic auth still accepted (no X-Signature → fallback to Basic)', async () => {
    await request(app).get(PING).set(basicAuth()).expect(200);
  });

  it('no auth at all returns 401', async () => {
    await request(app).get(PING).expect(401);
  });

  // ── /ping with global secret (no institution in path) ────────────────────

  it('global key accepted on /ping', async () => {
    const headers = signRequest('GET', PING, Buffer.alloc(0), GLOBAL_SECRET);
    await request(app).get(PING).set(headers).expect(200);
  });

  it('returns 401 when X-Signature present but X-Timestamp missing', async () => {
    const res = await request(app)
      .get(PING)
      .set({ 'X-Signature': 'deabeef' })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for wrong signature', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .get(PING)
      .set({ 'X-Timestamp': String(ts), 'X-Signature': 'badbadbadbad' })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when timestamp is outside skew window (10 min old)', async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const canonical = buildCanonical('GET', PING, Buffer.alloc(0), staleTs);
    const sig = crypto.createHmac('sha256', GLOBAL_SECRET).update(canonical).digest('hex');
    const res = await request(app)
      .get(PING)
      .set({ 'X-Timestamp': String(staleTs), 'X-Signature': sig })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // ── Institution routes ────────────────────────────────────────────────────

  it('per-institution key accepted on institution route', async () => {
    const headers = signRequest('GET', INST_DASHBOARD, Buffer.alloc(0), PER_INST_SECRET);
    await request(app).get(INST_DASHBOARD).set(headers).expect(200);
  });

  it('global key accepted on institution route', async () => {
    const headers = signRequest('GET', INST_DASHBOARD, Buffer.alloc(0), GLOBAL_SECRET);
    await request(app).get(INST_DASHBOARD).set(headers).expect(200);
  });

  // ── Precedence: X-Signature present → no Basic fallback ──────────────────

  it('X-Signature with wrong sig → 401 even when valid Basic creds are also present', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .get(PING)
      .set({
        ...basicAuth(),
        'X-Timestamp': String(ts),
        'X-Signature': 'invalid-hex',
      })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // ── Nonce ────────────────────────────────────────────────────────────────

  it('signed request with nonce accepted', async () => {
    const nonce = 'unique-abc-123';
    const headers = signRequest('GET', PING, Buffer.alloc(0), GLOBAL_SECRET, undefined, nonce);
    await request(app).get(PING).set(headers).expect(200);
  });

  it('returns 401 when nonce is in header but was not included when signing', async () => {
    const ts = Math.floor(Date.now() / 1000);
    // Sign WITHOUT nonce, then send WITH nonce header → HMAC mismatch
    const canonical = buildCanonical('GET', PING, Buffer.alloc(0), ts);
    const sig = crypto.createHmac('sha256', GLOBAL_SECRET).update(canonical).digest('hex');
    const res = await request(app)
      .get(PING)
      .set({ 'X-Timestamp': String(ts), 'X-Signature': sig, 'X-Nonce': 'surprise' })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // ── Path integrity ────────────────────────────────────────────────────────

  it('returns 401 when signed path differs from actual request path', async () => {
    // Sign for INST_DASHBOARD but send to INST_FILES
    const headers = signRequest('GET', INST_DASHBOARD, Buffer.alloc(0), PER_INST_SECRET);
    await request(app).get(INST_FILES).set(headers).expect(401);
  });

  // ── Body hashing ──────────────────────────────────────────────────────────

  it('signed PATCH with JSON body accepted when signature covers exact raw body', async () => {
    const body = JSON.stringify({ remediation_delivery: { mode: 'opt_in' } });
    const headers = signRequest('PATCH', INST_SETTINGS, Buffer.from(body), PER_INST_SECRET);

    await request(app)
      .patch(INST_SETTINGS)
      .set({ ...headers, 'Content-Type': 'application/json' })
      .send(body)
      .expect(200);
  });

  it('returns 401 when body is tampered after signing', async () => {
    const originalBody = JSON.stringify({ remediation_delivery: { mode: 'opt_in' } });
    const tamperedBody = JSON.stringify({ remediation_delivery: { mode: 'opt_out' } });
    const headers = signRequest('PATCH', INST_SETTINGS, Buffer.from(originalBody), PER_INST_SECRET);

    await request(app)
      .patch(INST_SETTINGS)
      .set({ ...headers, 'Content-Type': 'application/json' })
      .send(tamperedBody)
      .expect(401);
  });

  // ── Scope enforcement after auth ──────────────────────────────────────────

  it('returns 404 for unknown institution (signed auth passes, scope fails)', async () => {
    mockInstitutionFindUnique.mockResolvedValue(null);
    const headers = signRequest('GET', INST_DASHBOARD, Buffer.alloc(0), PER_INST_SECRET);
    await request(app).get(INST_DASHBOARD).set(headers).expect(404);
  });
});
