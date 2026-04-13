import axios, { AxiosInstance } from 'axios';
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
    });
  }

  // Fetches all pages of a paginated Canvas endpoint.
  // Canvas signals the next page via a Link header: rel="next"
  async getPaginated<T>(path: string, params: Record<string, unknown> = {}): Promise<T[]> {
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

  private parseNextLink(linkHeader: string | undefined): string | null {
    if (!linkHeader) return null;

    // Link header format: <https://...?page=2>; rel="next", <https://...?page=1>; rel="first"
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }
}
