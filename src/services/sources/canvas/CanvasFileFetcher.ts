import axios from 'axios';
import { Institution } from '@prisma/client';
import { CanvasClient } from './CanvasClient';
import { ISourceClient } from '../ISourceClient';
import { DiscoveredCourse, DiscoveredFile } from '../../../types/source';
import { CanvasCourse, CanvasFile } from '../../../types/canvas';
import { logger } from '../../../utils/logger';

// All MIME types we pull from Canvas
const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  // PowerPoint
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  // Excel
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

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

    const canvasCourses = await this.client.getPaginated<CanvasCourse>(
      `/accounts/${this.client.accountId}/courses`,
      { state: ['available'], enrollment_type: 'teacher' },
    );

    logger.info('Canvas: courses fetched', { count: canvasCourses.length });

    return canvasCourses.map((c) => ({
      externalId: c.id.toString(),
      name: c.name,
      courseCode: c.course_code ?? null,
      termId: c.enrollment_term_id ? c.enrollment_term_id.toString() : null,
    }));
  }

  async getFiles(courseExternalId: string, lastSyncedAt: Date | null): Promise<DiscoveredFile[]> {
    logger.info('Canvas: fetching files', { courseId: courseExternalId, lastSyncedAt });

    // Build content_types filter params
    const contentTypeParams = SUPPORTED_MIME_TYPES.reduce<Record<string, string>>(
      (acc, mimeType, i) => {
        acc[`content_types[${i}]`] = mimeType;
        return acc;
      },
      {},
    );

    // Sort by updated_at descending so we can stop early on incremental syncs
    const allFiles = await this.client.getPaginated<CanvasFile>(
      `/courses/${courseExternalId}/files`,
      { sort: 'updated_at', order: 'desc', ...contentTypeParams },
    );

    logger.info('Canvas: raw files fetched', { courseId: courseExternalId, count: allFiles.length });

    // On incremental syncs: discard files whose updated_at predates the last sync.
    // We still run modified_at comparison in FileChangeDetector for accuracy —
    // this is purely an optimisation to trim the list early.
    const files = lastSyncedAt
      ? allFiles.filter((f) => new Date(f.updated_at) >= lastSyncedAt)
      : allFiles;

    logger.info('Canvas: files after incremental filter', {
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
