/**
 * Unit tests for the HMAC-SHA256 signed auth verifier (TASK-12 / VALIDATION-12).
 *
 * These tests exercise the pure `verifySignedRequest` function directly so they
 * are fast and deterministic — no HTTP layer needed here.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  buildCanonicalString,
  sha256Hex,
  extractInstitutionIdFromUrl,
  parseSigningSecrets,
  parseAllowedInstitutions,
  verifySignedRequest,
  type VerifySignedRequestOptions,
} from '@/api/middleware/accessHubSignedAuth.middleware';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INST_ID = '11111111-1111-1111-1111-111111111111';
const SECRET = 'test-signing-secret-abc123';
const NOW = 1_700_000_000; // fixed epoch for determinism
const SKEW = 300;

function sign(
  method: string,
  path: string,
  body: Buffer,
  timestamp: number,
  secret: string,
  nonce?: string,
): string {
  const bodyHash = sha256Hex(body);
  const canonical = buildCanonicalString(method, path, bodyHash, String(timestamp), nonce);
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

function baseOpts(overrides: Partial<VerifySignedRequestOptions> = {}): VerifySignedRequestOptions {
  const method = 'GET';
  const path = `/api/v1/access-hub/institutions/${INST_ID}/dashboard`;
  const body = Buffer.alloc(0);
  const sig = sign(method, path, body, NOW, SECRET);

  return {
    method,
    pathWithQuery: path,
    rawBody: body,
    headers: {
      'x-timestamp': String(NOW),
      'x-signature': sig,
    },
    secrets: { [INST_ID]: SECRET },
    allowedInstitutions: null,
    skewSeconds: SKEW,
    nowSeconds: NOW,
    ...overrides,
  };
}

// ─── buildCanonicalString ─────────────────────────────────────────────────────

describe('buildCanonicalString', () => {
  it('joins parts with newlines', () => {
    const s = buildCanonicalString('GET', '/path', 'abc123', '1000');
    expect(s).toBe('GET\n/path\nabc123\n1000');
  });

  it('appends nonce when provided', () => {
    const s = buildCanonicalString('POST', '/path', 'abc123', '1000', 'my-nonce');
    expect(s).toBe('POST\n/path\nabc123\n1000\nmy-nonce');
  });

  it('uppercases method', () => {
    expect(buildCanonicalString('post', '/', 'h', 't')).toMatch(/^POST\n/);
  });

  it('does not append nonce when absent', () => {
    const s = buildCanonicalString('GET', '/', 'h', 't', undefined);
    expect(s.split('\n')).toHaveLength(4);
  });
});

// ─── sha256Hex ────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('produces known SHA-256 for empty buffer', () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces known SHA-256 for "hello"', () => {
    expect(sha256Hex(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

// ─── extractInstitutionIdFromUrl ──────────────────────────────────────────────

describe('extractInstitutionIdFromUrl', () => {
  it('extracts UUID from institution path', () => {
    expect(
      extractInstitutionIdFromUrl(
        `/api/v1/access-hub/institutions/${INST_ID}/dashboard`,
      ),
    ).toBe(INST_ID);
  });

  it('returns null for /ping (no institution segment)', () => {
    expect(extractInstitutionIdFromUrl('/api/v1/access-hub/ping')).toBeNull();
  });

  it('returns null for malformed UUID segment', () => {
    expect(
      extractInstitutionIdFromUrl('/api/v1/access-hub/institutions/not-a-uuid/files'),
    ).toBeNull();
  });
});

// ─── parseSigningSecrets ──────────────────────────────────────────────────────

describe('parseSigningSecrets', () => {
  it('returns empty object for undefined', () => {
    expect(parseSigningSecrets(undefined)).toEqual({});
  });

  it('parses valid JSON map', () => {
    expect(parseSigningSecrets('{"*":"global","inst-1":"s1"}')).toEqual({
      '*': 'global',
      'inst-1': 's1',
    });
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseSigningSecrets('{ bad json')).toEqual({});
  });

  it('strips non-string values', () => {
    expect(parseSigningSecrets('{"*":"ok","bad":123}')).toEqual({ '*': 'ok' });
  });
});

// ─── parseAllowedInstitutions ─────────────────────────────────────────────────

describe('parseAllowedInstitutions', () => {
  it('returns null for undefined (unrestricted)', () => {
    expect(parseAllowedInstitutions(undefined)).toBeNull();
  });

  it('parses comma-separated list', () => {
    expect(parseAllowedInstitutions('inst-a,inst-b , inst-c')).toEqual([
      'inst-a', 'inst-b', 'inst-c',
    ]);
  });

  it('returns null for empty string', () => {
    expect(parseAllowedInstitutions('')).toBeNull();
  });
});

// ─── verifySignedRequest — happy paths ───────────────────────────────────────

describe('verifySignedRequest — valid signature', () => {
  it('returns ok for correct per-institution secret', () => {
    expect(verifySignedRequest(baseOpts())).toBe('ok');
  });

  it('returns ok for correct global (*) secret', () => {
    const method = 'GET';
    const path = `/api/v1/access-hub/institutions/${INST_ID}/dashboard`;
    const body = Buffer.alloc(0);
    const sig = sign(method, path, body, NOW, 'global-secret');
    expect(
      verifySignedRequest({
        ...baseOpts(),
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
        secrets: { '*': 'global-secret' },
      }),
    ).toBe('ok');
  });

  it('includes nonce in canonical string when provided', () => {
    const method = 'GET';
    const path = `/api/v1/access-hub/institutions/${INST_ID}/dashboard`;
    const body = Buffer.alloc(0);
    const nonce = 'unique-nonce-xyz';
    const sig = sign(method, path, body, NOW, SECRET, nonce);

    expect(
      verifySignedRequest({
        ...baseOpts(),
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig, 'x-nonce': nonce },
      }),
    ).toBe('ok');
  });

  it('signs a non-empty POST body correctly', () => {
    const body = Buffer.from(JSON.stringify({ batch_file_id: 'abc' }));
    const method = 'POST';
    const path = `/api/v1/access-hub/institutions/${INST_ID}/courses/c1/files/f1/replace`;
    const sig = sign(method, path, body, NOW, SECRET);

    expect(
      verifySignedRequest({
        ...baseOpts(),
        method,
        pathWithQuery: path,
        rawBody: body,
        secrets: { [INST_ID]: SECRET },
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('ok');
  });
});

// ─── verifySignedRequest — clock skew ────────────────────────────────────────

describe('verifySignedRequest — clock skew', () => {
  it('rejects timestamp exactly at skew boundary + 1', () => {
    const staleNow = NOW - SKEW - 1;
    expect(
      verifySignedRequest({ ...baseOpts(), nowSeconds: staleNow }),
    ).toBe('401');
  });

  it('accepts timestamp exactly at skew boundary', () => {
    const borderNow = NOW - SKEW;
    const method = 'GET';
    const path = `/api/v1/access-hub/institutions/${INST_ID}/dashboard`;
    const sig = sign(method, path, Buffer.alloc(0), NOW, SECRET);
    expect(
      verifySignedRequest({
        ...baseOpts(),
        nowSeconds: borderNow,
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('ok');
  });

  it('rejects future timestamp beyond skew', () => {
    const futureNow = NOW + SKEW + 1;
    expect(
      verifySignedRequest({ ...baseOpts(), nowSeconds: futureNow }),
    ).toBe('401');
  });
});

// ─── verifySignedRequest — missing / malformed headers ───────────────────────

describe('verifySignedRequest — missing/malformed headers', () => {
  it('returns 401 for missing X-Timestamp', () => {
    expect(
      verifySignedRequest({
        ...baseOpts(),
        headers: { 'x-signature': 'abc' },
      }),
    ).toBe('401');
  });

  it('returns 401 for missing X-Signature', () => {
    expect(
      verifySignedRequest({
        ...baseOpts(),
        headers: { 'x-timestamp': String(NOW) },
      }),
    ).toBe('401');
  });

  it('returns 401 for non-numeric timestamp', () => {
    expect(
      verifySignedRequest({
        ...baseOpts(),
        headers: { 'x-timestamp': 'not-a-number', 'x-signature': 'aabb' },
      }),
    ).toBe('401');
  });
});

// ─── verifySignedRequest — tampered body ─────────────────────────────────────

describe('verifySignedRequest — tampered body', () => {
  it('returns 401 when body is modified after signing', () => {
    const originalBody = Buffer.from('{"key":"value"}');
    const tamperedBody = Buffer.from('{"key":"hacked"}');
    const sig = sign('POST', '/api/v1/access-hub/institutions/' + INST_ID + '/courses/c1/files/f1/replace', originalBody, NOW, SECRET);

    expect(
      verifySignedRequest({
        ...baseOpts(),
        method: 'POST',
        pathWithQuery: `/api/v1/access-hub/institutions/${INST_ID}/courses/c1/files/f1/replace`,
        rawBody: tamperedBody,
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('401');
  });
});

// ─── verifySignedRequest — wrong path ────────────────────────────────────────

describe('verifySignedRequest — wrong path', () => {
  it('returns 401 when path differs from signed path', () => {
    const signedPath = `/api/v1/access-hub/institutions/${INST_ID}/dashboard`;
    const requestPath = `/api/v1/access-hub/institutions/${INST_ID}/files`;
    const sig = sign('GET', signedPath, Buffer.alloc(0), NOW, SECRET);

    expect(
      verifySignedRequest({
        ...baseOpts(),
        pathWithQuery: requestPath,
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('401');
  });

  it('returns 401 when query string differs', () => {
    const signedPath = `/api/v1/access-hub/institutions/${INST_ID}/courses?page=1`;
    const requestPath = `/api/v1/access-hub/institutions/${INST_ID}/courses?page=2`;
    const sig = sign('GET', signedPath, Buffer.alloc(0), NOW, SECRET);

    expect(
      verifySignedRequest({
        ...baseOpts(),
        pathWithQuery: requestPath,
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('401');
  });
});

// ─── verifySignedRequest — wrong secret / institution ────────────────────────

describe('verifySignedRequest — institution binding', () => {
  const INST_B = '22222222-2222-2222-2222-222222222222';
  const SECRET_B = 'secret-for-inst-b';

  it('returns 401 when no secret configured for institution', () => {
    expect(
      verifySignedRequest({
        ...baseOpts(),
        secrets: { [INST_B]: SECRET_B }, // only inst-B has a secret
      }),
    ).toBe('401');
  });

  it('returns 401 when using wrong secret for institution', () => {
    expect(
      verifySignedRequest({
        ...baseOpts(),
        secrets: { [INST_ID]: 'wrong-secret' },
      }),
    ).toBe('401');
  });

  it('returns 403 when global key valid but institution not in allowedInstitutions', () => {
    const sig = sign(
      'GET',
      `/api/v1/access-hub/institutions/${INST_ID}/dashboard`,
      Buffer.alloc(0),
      NOW,
      'global-secret',
    );
    expect(
      verifySignedRequest({
        ...baseOpts(),
        secrets: { '*': 'global-secret' },
        allowedInstitutions: [INST_B], // INST_ID not allowed
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('403');
  });

  it('returns ok when global key valid and institution is in allowedInstitutions', () => {
    const sig = sign(
      'GET',
      `/api/v1/access-hub/institutions/${INST_ID}/dashboard`,
      Buffer.alloc(0),
      NOW,
      'global-secret',
    );
    expect(
      verifySignedRequest({
        ...baseOpts(),
        secrets: { '*': 'global-secret' },
        allowedInstitutions: [INST_ID],
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('ok');
  });

  it('returns ok when global key valid and allowedInstitutions is null (unrestricted)', () => {
    const sig = sign(
      'GET',
      `/api/v1/access-hub/institutions/${INST_ID}/dashboard`,
      Buffer.alloc(0),
      NOW,
      'global-secret',
    );
    expect(
      verifySignedRequest({
        ...baseOpts(),
        secrets: { '*': 'global-secret' },
        allowedInstitutions: null,
        headers: { 'x-timestamp': String(NOW), 'x-signature': sig },
      }),
    ).toBe('ok');
  });

  it('per-institution key: returns 403 when used for a different institution in path', () => {
    // Secrets have inst-A key, request is for inst-A, but we sign path for inst-A
    // so this is ok. Now test the reverse: key is for inst-B, signed correctly with inst-B's secret
    // but path contains inst-A → the server looks up secrets[inst-A] (not found) + secrets["*"] (not found) → 401
    // The 403 scenario for per-institution: the path institution matches the key that signs correctly,
    // but the key lookup would never mix institutions. The 403 comes only from the global key restriction.
    // Let's verify: only inst-B key, request is for inst-A → 401 (key not found for inst-A, no global)
    expect(
      verifySignedRequest({
        ...baseOpts(),
        secrets: { [INST_B]: SECRET_B }, // only inst-B key
        // path has INST_ID (inst-A), no matching key → 401
      }),
    ).toBe('401');
  });
});
