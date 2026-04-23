/**
 * HMAC-SHA256 signed service request authentication (TASK-12 / VALIDATION-12).
 * Tech §5.3.
 *
 * ## Canonical string (documented here per §5.3 "exact headers … belong in implementation")
 *
 * ```
 * {METHOD}\n{PATH_WITH_QUERY}\n{BODY_SHA256_HEX}\n{TIMESTAMP}[\n{NONCE}]
 * ```
 *
 * | Part             | Value                                                         |
 * |------------------|---------------------------------------------------------------|
 * | METHOD           | Uppercase HTTP method (GET, POST, PATCH, …)                  |
 * | PATH_WITH_QUERY  | `req.originalUrl` — full path + query string                  |
 * | BODY_SHA256_HEX  | Hex-encoded SHA-256 of raw body bytes; empty string SHA-256   |
 * |                  | (`e3b0c4…`) when there is no body                             |
 * | TIMESTAMP        | `X-Timestamp` header value — Unix seconds, decimal string     |
 * | NONCE            | `X-Nonce` header value (optional — appended only if present)  |
 *
 * ## Headers
 *
 * | Header        | Required | Description                          |
 * |---------------|----------|--------------------------------------|
 * | X-Timestamp   | yes      | Unix timestamp in seconds             |
 * | X-Signature   | yes      | Hex HMAC-SHA256 over canonical string |
 * | X-Nonce       | no       | Replay-protection nonce               |
 *
 * ## Signing secrets config (`ACCESS_HUB_SIGNING_SECRETS`)
 *
 * JSON map `{ "<keyId>": "<secret>" }` where keyId is either:
 * - An institution UUID — secret is bound to that institution only (403 if path does not match)
 * - `"*"` — global deployment secret, allowed for any institution unless
 *   `ACCESS_HUB_SIGNING_ALLOWED_INSTITUTIONS` restricts it to a comma-separated list
 *
 * ## Auth precedence (documented per VALIDATION-12)
 *
 * 1. If `X-Signature` header is present → signed auth is attempted; **no fallback** to Basic
 * 2. If `X-Signature` is absent → fall through to Basic auth check
 *
 * ## Error codes
 *
 * - **401** — signature missing, malformed, HMAC mismatch, or timestamp outside skew window
 * - **403** — HMAC is valid but the key is not authorised for the institution in the path
 *
 * ## Security notes
 *
 * - Comparison uses `crypto.timingSafeEqual` to prevent timing attacks
 * - Secret material is never logged
 * - TLS is required in non-dev environments (§7.1) — enforced by deployment, not this middleware
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config';
import { Errors } from '../../utils/errors';
import { accessHubBasicAuth } from './accessHubBasicAuth.middleware';

// ─── Canonical string ─────────────────────────────────────────────────────────

export function buildCanonicalString(
  method: string,
  pathWithQuery: string,
  bodyHashHex: string,
  timestamp: string,
  nonce?: string,
): string {
  const parts = [method.toUpperCase(), pathWithQuery, bodyHashHex, timestamp];
  if (nonce) parts.push(nonce);
  return parts.join('\n');
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ─── Institution ID extraction ────────────────────────────────────────────────

const INSTITUTION_PATH_RE = /\/institutions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function extractInstitutionIdFromUrl(url: string): string | null {
  const m = INSTITUTION_PATH_RE.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

// ─── Secrets parsing ──────────────────────────────────────────────────────────

export function parseSigningSecrets(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    // Strip non-string values silently
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export function parseAllowedInstitutions(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null; // null = unrestricted
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ─── Core verification (pure, exported for unit tests) ───────────────────────

export type VerifyResult = 'ok' | '401' | '403';

export interface VerifySignedRequestOptions {
  method: string;
  pathWithQuery: string;
  rawBody: Buffer;
  headers: {
    'x-timestamp'?: string;
    'x-signature'?: string;
    'x-nonce'?: string;
  };
  secrets: Record<string, string>;
  allowedInstitutions: string[] | null;
  skewSeconds: number;
  nowSeconds?: number; // injectable for tests
}

export function verifySignedRequest(opts: VerifySignedRequestOptions): VerifyResult {
  const { timestamp: ts, signature: sig, nonce } = {
    timestamp: opts.headers['x-timestamp'],
    signature: opts.headers['x-signature'],
    nonce: opts.headers['x-nonce'],
  };

  if (!ts || !sig) return '401';

  // Validate and check timestamp skew
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || String(tsNum) !== ts.trim()) return '401';

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > opts.skewSeconds) return '401';

  // Compute body hash
  const bodyHash = sha256Hex(opts.rawBody);

  // Build canonical string
  const canonical = buildCanonicalString(
    opts.method,
    opts.pathWithQuery,
    bodyHash,
    ts,
    nonce,
  );

  // Extract institution_id from path (null for non-institution routes)
  const institutionId = extractInstitutionIdFromUrl(opts.pathWithQuery);

  // Build candidate list: per-institution key first (more specific), then global
  type Candidate = { keyId: string; secret: string };
  const candidates: Candidate[] = [];
  if (institutionId && opts.secrets[institutionId]) {
    candidates.push({ keyId: institutionId, secret: opts.secrets[institutionId]! });
  }
  if (opts.secrets['*']) {
    candidates.push({ keyId: '*', secret: opts.secrets['*']! });
  }

  if (candidates.length === 0) return '401';

  // Validate signature hex (must be valid hex and expected length)
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    if (sigBuf.length === 0) return '401';
  } catch {
    return '401';
  }

  for (const { keyId, secret } of candidates) {
    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(canonical, 'utf8')
      .digest('hex');
    const expBuf = Buffer.from(expectedHex, 'hex');

    if (sigBuf.length !== expBuf.length) continue;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) continue;

    // HMAC matches — check institution binding
    if (keyId !== '*') {
      // Per-institution key: institution_id in path must equal keyId
      if (!institutionId || institutionId !== keyId) return '403';
    } else {
      // Global key: check allowedInstitutions restriction
      if (
        opts.allowedInstitutions !== null &&
        institutionId !== null &&
        !opts.allowedInstitutions.includes(institutionId)
      ) {
        return '403';
      }
    }
    return 'ok';
  }

  return '401';
}

// ─── Lazy-parsed config values ────────────────────────────────────────────────

let _secrets: Record<string, string> | null = null;
let _allowedInstitutions: string[] | null | undefined = undefined; // undefined = not yet parsed

function getSecrets(): Record<string, string> {
  if (_secrets !== null) return _secrets;
  _secrets = parseSigningSecrets(config.accessHub.signingSecrets);
  return _secrets;
}

function getAllowedInstitutions(): string[] | null {
  if (_allowedInstitutions !== undefined) return _allowedInstitutions;
  _allowedInstitutions = parseAllowedInstitutions(
    config.accessHub.signingAllowedInstitutions,
  );
  return _allowedInstitutions;
}

// ─── Combined auth middleware ─────────────────────────────────────────────────

/**
 * Combined Access Hub authentication middleware.
 *
 * Precedence (documented per VALIDATION-12):
 * 1. If `X-Signature` header is present → signed auth (no fallback to Basic)
 * 2. Otherwise → HTTP Basic auth
 */
export function accessHubAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const signatureHeader = req.headers['x-signature'];

  if (signatureHeader) {
    // Signed auth path
    const secrets = getSecrets();
    const result = verifySignedRequest({
      method: req.method,
      pathWithQuery: req.originalUrl,
      rawBody: req.rawBody ?? Buffer.alloc(0),
      headers: {
        'x-timestamp': req.headers['x-timestamp'] as string | undefined,
        'x-signature': req.headers['x-signature'] as string | undefined,
        'x-nonce': req.headers['x-nonce'] as string | undefined,
      },
      secrets,
      allowedInstitutions: getAllowedInstitutions(),
      skewSeconds: config.accessHub.signingSkewSeconds,
    });

    if (result === 'ok') { next(); return; }
    if (result === '403') {
      next(Errors.forbidden('Signing key not authorised for this institution'));
      return;
    }
    next(Errors.unauthorized('Invalid or expired request signature'));
    return;
  }

  // Fallback: HTTP Basic auth (TASK-01)
  accessHubBasicAuth(req, res, next);
}
