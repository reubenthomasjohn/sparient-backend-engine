import axios, { AxiosInstance } from 'axios';
import { CanvasTerm } from '../../../types/canvas';
import { logger } from '../../../utils/logger';

interface CanvasCredentials {
  domain: string;
  account_id: string;
  api_token: string;
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
  async getFile(fileExternalId: string): Promise<import('../../../types/canvas').CanvasFile> {
    const response = await this.http.get<import('../../../types/canvas').CanvasFile>(
      `/files/${fileExternalId}`,
    );
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

  private parseNextLink(linkHeader: string | undefined): string | null {
    if (!linkHeader) return null;

    // Link header format: <https://...?page=2>; rel="next", <https://...?page=1>; rel="first"
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }
}
