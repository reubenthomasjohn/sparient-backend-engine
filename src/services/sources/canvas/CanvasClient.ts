import axios, { AxiosInstance } from 'axios';
import { CanvasFile, CanvasFolder, CanvasTerm } from '../../../types/canvas';
import { logger } from '../../../utils/logger';

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
      // Canvas expects repeated keys for arrays: content_types[]=a&content_types[]=b
      // axios's default serialises as content_types[0]=a which Canvas ignores
      paramsSerializer: (params: Record<string, unknown>) => {
        const parts = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (Array.isArray(value)) {
            value.forEach((v) => parts.append(key, String(v)));
          } else if (value !== undefined && value !== null) {
            parts.append(key, String(value));
          }
        }
        return parts.toString();
      },
    });
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
    const uploadResponse = await axios.post(init.upload_url, form, {
      maxRedirects: 0,
      // Accept redirects *and* 201s as success; anything else throws.
      validateStatus: (s) => s === 201 || (s >= 300 && s < 400),
      timeout: 300_000,
    });

    if (uploadResponse.status === 201) {
      return uploadResponse.data as CanvasFile;
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
