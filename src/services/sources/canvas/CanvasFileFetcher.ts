import axios from 'axios';
import { Institution } from '@prisma/client';
import { CanvasClient } from './CanvasClient';
import { ISourceClient } from '../ISourceClient';
import { DiscoveredCourse, DiscoveredFile } from '../../../types/source';
import { CanvasCourse, CanvasFile, CanvasTerm } from '../../../types/canvas';
import { logger } from '../../../utils/logger';

// Used as a server-side filter on the Canvas API request to reduce response size.
// Canvas doesn't always assign correct MIME types, so we also check extensions
// client-side below to catch files served as application/octet-stream etc.
const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.doc', '.docx',
  '.ppt', '.pptx',
  '.xls', '.xlsx',
]);

// A term is active if now falls within its date range.
// null start_at = no lower bound (treat as already started).
// null end_at   = no upper bound (treat as never-ending, e.g. the Default Term).
function isActiveTerm(term: CanvasTerm, now: Date): boolean {
  if (term.start_at !== null && new Date(term.start_at) > now) return false;
  if (term.end_at !== null && new Date(term.end_at) < now) return false;
  return true;
}

// Extension check is the canonical filter — Canvas doesn't always assign correct MIME types
// (e.g. application/octet-stream for .docx), so we can't rely on content-type alone.
// The SUPPORTED_MIME_TYPES array above is passed as a server-side hint only.
function isSupportedFile(file: CanvasFile): boolean {
  const ext = '.' + file.filename.split('.').pop()?.toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export class CanvasFileFetcher implements ISourceClient {
  private readonly client: CanvasClient;

  constructor(institution: Institution) {
    const credentials = institution.credentials as {
      domain: string;
      account_id: string;
      api_token: string;
    };
    this.client = new CanvasClient(credentials);
  }

  async getCourses(): Promise<DiscoveredCourse[]> {
    logger.info('Canvas: fetching courses', { accountId: this.client.accountId });

    const [canvasCourses, terms] = await Promise.all([
      this.client.getPaginated<CanvasCourse>(
        `/accounts/${this.client.accountId}/courses`,
        { state: ['available'], enrollment_type: 'teacher' },
      ),
      this.client.getTerms(),
    ]);

    const now = new Date();
    const activeTermIds = new Set(terms.filter((t) => isActiveTerm(t, now)).map((t) => t.id));

    const activeCourses = canvasCourses.filter((c) => activeTermIds.has(c.enrollment_term_id));

    logger.info('Canvas: courses fetched', {
      total: canvasCourses.length,
      activeTerms: activeTermIds.size,
      afterTermFilter: activeCourses.length,
    });

    return activeCourses.map((c) => ({
      externalId: c.id.toString(),
      name: c.name,
      courseCode: c.course_code ?? null,
      termId: c.enrollment_term_id ? c.enrollment_term_id.toString() : null,
    }));
  }

  async getFiles(courseExternalId: string, lastSyncedAt: Date | null): Promise<DiscoveredFile[]> {
    logger.info('Canvas: fetching files', { courseId: courseExternalId, lastSyncedAt });

    // Sort by updated_at descending so we can stop early on incremental syncs.
    // content_types[] is serialised as repeated keys by our custom paramsSerializer:
    // content_types[]=application/pdf&content_types[]=application/msword&...
    const allFiles = await this.client.getPaginated<CanvasFile>(
      `/courses/${courseExternalId}/files`,
      { sort: 'updated_at', order: 'desc', 'content_types[]': SUPPORTED_MIME_TYPES },
    );

    logger.info('Canvas: raw files fetched', { courseId: courseExternalId, count: allFiles.length });

    // On incremental syncs: discard files whose updated_at predates the last sync.
    // We still run modified_at comparison in FileChangeDetector for accuracy —
    // this is purely an optimisation to trim the list early.
    const afterDateFilter = lastSyncedAt
      ? allFiles.filter((f) => new Date(f.updated_at) >= lastSyncedAt)
      : allFiles;

    // Extension check catches files Canvas served with a wrong MIME type
    // (e.g. application/octet-stream) that slipped past the server-side filter.
    const files = afterDateFilter.filter(isSupportedFile);

    logger.info('Canvas: files after incremental + extension filter', {
      courseId: courseExternalId,
      count: files.length,
    });

    return files.map((f) => ({
      externalId: f.id.toString(),
      displayName: f.display_name,
      fileName: f.filename,
      mimeType: f['content-type'],
      sizeBytes: f.size ?? null,
      modifiedAt: new Date(f.modified_at),
      downloadUrl: f.url,
    }));
  }

  async downloadFile(downloadUrl: string): Promise<Buffer> {
    const response = await axios.get<ArrayBuffer>(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
    });
    return Buffer.from(response.data);
  }
}
