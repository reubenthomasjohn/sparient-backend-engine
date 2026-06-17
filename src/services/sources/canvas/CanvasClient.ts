import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import JSONBig from 'json-bigint';
import { CanvasCourse, CanvasFile, CanvasFolder, CanvasTerm } from '../../../types/canvas';
import { logger } from '../../../utils/logger';

// Bounded retry for transient Canvas errors. 429 (rate limit) is retried for ANY method
// since the request wasn't processed; 5xx / network / timeout are retried only for
// idempotent reads (retrying a POST could double-submit). Honors Retry-After, otherwise
// exponential backoff. Kept small so a single call's worst case (2 retries × (≤8s sleep +
// 30s request timeout)) stays well under the writeback Lambda's 150s budget. Note: a flow
// making several calls can still accumulate beyond that — callers should not assume the
// whole operation is bounded by a single request's retry budget.
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(error: AxiosError, attempt: number): number {
  const retryAfter = Number(error.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_DELAY_MS);
  }
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

// Canvas Enterprise tenants assign integer IDs exceeding Number.MAX_SAFE_INTEGER
// (18+ digits). The default JSON.parse silently rounds the trailing digits,
// breaking every downstream comparison. json-bigint with `storeAsString: true`
// returns ALL JSON integers as strings, so the CanvasFile/CanvasCourse types
// can declare id-fields as `string` and stay consistent regardless of size.
const jsonBigParser = JSONBig({ storeAsString: true });

// Used as axios `transformResponse` for any request that may return a Canvas
// object. Both the shared `this.http` instance AND the bare axios.post in
// finishUpload need this — the latter goes to Inst-FS (a different host) but
// the response still contains a Canvas file with potentially huge ids.
function bigIntSafeJsonParse(data: unknown): unknown {
  if (typeof data !== 'string' || data.length === 0) return data;
  try {
    return jsonBigParser.parse(data);
  } catch {
    // Non-JSON responses (HTML error pages, etc.) shouldn't crash the parser.
    return data;
  }
}

// Canvas (Rails) expects repeated bracketed keys for array params:
//   state[]=available&state[]=claimed
// Without the `[]`, Rails collapses repeated keys to the LAST value (so
// `state=available&state=unpublished` becomes a scalar `unpublished`), silently
// returning the wrong/zero results. Callers may pass the key already bracketed
// (e.g. "content_types[]"); don't double-bracket those.
export function serializeCanvasParams(params: Record<string, unknown>): string {
  const parts = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
      value.forEach((v) => parts.append(arrayKey, String(v)));
    } else if (value !== undefined && value !== null) {
      parts.append(key, String(value));
    }
  }
  return parts.toString();
}

const REDACTED = '[REDACTED]';

// Redact the Bearer token from an AxiosError before it propagates. A thrown
// AxiosError is serialized — including config.headers — by our logger AND by the
// Lambda runtime on an uncaught throw, which would otherwise print the Canvas API
// token in plaintext to CloudWatch. We mutate in place and re-reject the SAME error
// so axios.isAxiosError() and err.response.status checks downstream still work.
// config.headers on a request is a per-request merge, so this never touches the
// client's default token used by subsequent requests.
export function redactCanvasAuthError(err: unknown): unknown {
  const e = err as {
    config?: { headers?: unknown };
    response?: { config?: { headers?: unknown } };
    request?: unknown;
  };
  // Node's http.ClientRequest (err.request) keeps the raw request head — including the
  // Authorization line — in ._header. toJSON() omits it, but a deep error dump would not.
  // Nothing downstream reads err.request (we branch on err.response.status), so drop it.
  if (e && typeof e === 'object' && 'request' in e) delete e.request;
  for (const headers of [e?.config?.headers, e?.response?.config?.headers]) {
    if (!headers || typeof headers !== 'object') continue;
    const h = headers as Record<string, unknown> & {
      get?: (k: string) => unknown;
      set?: (k: string, v: string) => void;
    };
    if (typeof h.get === 'function' && typeof h.set === 'function') {
      // AxiosHeaders instance.
      if (h.get('Authorization') != null) h.set('Authorization', REDACTED);
      if (h.get('authorization') != null) h.set('authorization', REDACTED);
    } else {
      for (const key of Object.keys(h)) {
        if (key.toLowerCase() === 'authorization') h[key] = REDACTED;
      }
    }
  }
  return err;
}

interface CanvasCredentials {
  domain: string;
  account_id: string;
  api_token: string;
}

interface UploadInitResponse {
  upload_url: string;
  upload_params: Record<string, string>;
  // The field name expected for the file part. Canvas usually wants "file".
  file_param?: string;
}

export interface CourseUploadParams {
  courseId: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  parentFolderId?: string;
  // 'overwrite' (default) replaces any file with the same name in parentFolderId
  // and preserves its file id. 'rename' auto-appends a numeric suffix on collision.
  onDuplicate?: 'overwrite' | 'rename';
}

export class CanvasClient {
  private readonly http: AxiosInstance;
  readonly accountId: string;

  constructor(credentials: CanvasCredentials) {
    this.accountId = credentials.account_id;
    this.http = axios.create({
      baseURL: `https://${credentials.domain}/api/v1`,
      headers: {
        Authorization: `Bearer ${credentials.api_token}`,
        'Content-Type': 'application/json',
      },
      // Canvas rate-limits aggressively; a conservative timeout prevents hanging jobs
      timeout: 30_000,
      // BigInt-safe response parsing — see bigIntSafeJsonParse helper above.
      transformResponse: [bigIntSafeJsonParse],
      // Bracketed-array serialization for Canvas/Rails — see serializeCanvasParams.
      paramsSerializer: serializeCanvasParams,
    });

    // Retry transient failures (429 / 5xx / network), then scrub the Bearer token from
    // whatever error finally propagates — an uncaught throw is otherwise logged with the
    // Authorization header in plaintext by our logger and the Lambda runtime.
    this.http.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config as (InternalAxiosRequestConfig & { _retryCount?: number }) | undefined;
        const status = error.response?.status;
        const method = (config?.method ?? 'get').toLowerCase();
        const is5xxOrNetwork = (typeof status === 'number' && status >= 500) || !error.response;
        const transient = status === 429 || (is5xxOrNetwork && IDEMPOTENT_METHODS.has(method));

        if (config && transient) {
          config._retryCount = (config._retryCount ?? 0) + 1;
          if (config._retryCount <= MAX_RETRIES) {
            const delay = retryDelayMs(error, config._retryCount);
            logger.warn('Canvas: retrying after transient error', {
              method,
              url: config.url,
              status: status ?? error.code,
              attempt: config._retryCount,
              delayMs: delay,
            });
            await sleep(delay);
            return this.http(config);
          }
        }
        return Promise.reject(redactCanvasAuthError(error));
      },
    );
  }

  // Fetches all pages of a paginated Canvas endpoint.
  // Canvas signals the next page via a Link header: rel="next"
  async getPaginated<T>(path: string, params: Record<string, unknown | unknown[]> = {}): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = null;

    // First request uses the structured path + params
    const firstResponse = await this.http.get<T[]>(path, {
      params: { per_page: 100, ...params },
    });

    results.push(...firstResponse.data);
    nextUrl = this.parseNextLink(firstResponse.headers['link']);

    // Subsequent requests follow the full URL from the Link header
    while (nextUrl) {
      logger.debug('Canvas: fetching next page', { url: nextUrl });
      const response = await this.http.get<T[]>(nextUrl);
      results.push(...response.data);
      nextUrl = this.parseNextLink(response.headers['link']);
    }

    return results;
  }

  // Fetch a single file's current metadata. Used by the upload worker to refresh the
  // pre-signed download URL (Canvas URLs expire quickly) right before streaming the bytes.
  async getFile(fileExternalId: string): Promise<CanvasFile> {
    const response = await this.http.get<CanvasFile>(`/files/${fileExternalId}`);
    return response.data;
  }

  // Fetch a single course directly by id. Returns null on 404 (course missing or not
  // visible to this token) so callers can treat "not found" as an empty result rather
  // than an error. Used by single-course discovery to bypass the account listing.
  async getCourse(courseExternalId: string): Promise<CanvasCourse | null> {
    try {
      const response = await this.http.get<CanvasCourse>(`/courses/${courseExternalId}`);
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  // Fetches all enrollment terms for the account.
  // The Canvas terms endpoint wraps its response in { enrollment_terms: [...] }
  // rather than returning a bare array, so it can't use getPaginated.
  // In practice no institution will have more than 100 terms.
  async getTerms(): Promise<CanvasTerm[]> {
    const response = await this.http.get<{ enrollment_terms: CanvasTerm[] }>(
      `/accounts/${this.accountId}/terms`,
      { params: { per_page: 100 } },
    );
    return response.data.enrollment_terms;
  }

  // Canvas file upload is a 3-step dance:
  //   1. POST to /courses/:id/files — Canvas returns an upload_url (Inst-FS) + params
  //   2. POST multipart to upload_url — the upload_params MUST come before the file field,
  //      and the upload_url is a separate host so the bearer token must NOT be sent
  //   3. If step 2 returned a 3xx redirect, POST empty to the Location header *with* the
  //      bearer token to finalise and get the file object back
  // Implemented with axios.maxRedirects=0 so we can distinguish the 201-in-one-shot path
  // from the redirect path (auth handling differs between them).
  async uploadCourseFile(body: Uint8Array, params: CourseUploadParams): Promise<CanvasFile> {
    const init = await this.initiateCourseUpload(params);
    return this.finishUpload(init, body, params.fileName, params.mimeType);
  }

  async deleteFile(fileExternalId: string): Promise<void> {
    await this.http.delete(`/files/${fileExternalId}`);
    logger.info('Canvas: file deleted', { fileId: fileExternalId });
  }

  // Needed by the replacer to map a file → owning course (a Canvas file object only
  // exposes folder_id; the folder carries context_type + context_id).
  async getFolder(folderId: string): Promise<CanvasFolder> {
    const response = await this.http.get<CanvasFolder>(`/folders/${folderId}`);
    return response.data;
  }

  private async initiateCourseUpload(params: CourseUploadParams): Promise<UploadInitResponse> {
    const body: Record<string, string | number> = {
      name: params.fileName,
      size: params.sizeBytes,
      content_type: params.mimeType,
      on_duplicate: params.onDuplicate ?? 'overwrite',
    };
    if (params.parentFolderId) body.parent_folder_id = params.parentFolderId;

    logger.info('Canvas: upload step 1 (notify)', {
      courseId: params.courseId,
      fileName: params.fileName,
      size: params.sizeBytes,
      onDuplicate: body.on_duplicate,
    });

    const response = await this.http.post<UploadInitResponse>(
      `/courses/${params.courseId}/files`,
      body,
    );
    return response.data;
  }

  private async finishUpload(
    init: UploadInitResponse,
    body: Uint8Array,
    fileName: string,
    mimeType: string,
  ): Promise<CanvasFile> {
    const form = new FormData();
    // Canvas requires upload_params to be serialised *before* the file field.
    for (const [key, value] of Object.entries(init.upload_params)) {
      form.append(key, value);
    }
    form.append(init.file_param ?? 'file', new Blob([body], { type: mimeType }), fileName);

    logger.info('Canvas: upload step 2 (bytes)', { uploadUrl: init.upload_url, bytes: body.byteLength });

    // No bearer here — upload_url lives on Inst-FS, not the Canvas API host.
    // We MUST apply bigIntSafeJsonParse here too — Inst-FS returns the new
    // Canvas file object on 201 with the same large-id risk as the main API.
    // axios's default JSON.parse on this response would mangle Enterprise IDs.
    // The <CanvasFile> generic types `uploadResponse.data` so the cast at
    // the 201 branch is type-checked rather than blindly trusting `any`.
    const uploadResponse = await axios.post<CanvasFile>(init.upload_url, form, {
      maxRedirects: 0,
      // Accept redirects *and* 201s as success; anything else throws.
      validateStatus: (s) => s === 201 || (s >= 300 && s < 400),
      timeout: 300_000,
      transformResponse: [bigIntSafeJsonParse],
    });

    if (uploadResponse.status === 201) {
      return uploadResponse.data;
    }

    const location = uploadResponse.headers['location'];
    if (!location) throw new Error('Canvas upload redirect returned no Location header');

    logger.info('Canvas: upload step 3 (confirm)', { location });

    // Step 3 is back on the Canvas API host — bearer required.
    const confirm = await this.http.post<CanvasFile>(location, null, {
      // location is an absolute URL; axios respects that and bypasses baseURL.
      headers: { 'Content-Length': '0' },
    });
    return confirm.data;
  }

  private parseNextLink(linkHeader: string | undefined): string | null {
    if (!linkHeader) return null;

    // Link header format: <https://...?page=2>; rel="next", <https://...?page=1>; rel="first"
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }
}
