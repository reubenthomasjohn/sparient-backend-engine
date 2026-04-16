import { Readable } from 'stream';
import { DiscoveredCourse, DiscoveredFile } from '../../types/source';

export interface ISourceClient {
  getCourses(): Promise<DiscoveredCourse[]>;
  getFiles(courseExternalId: string, lastSyncedAt: Date | null): Promise<DiscoveredFile[]>;

  // Refresh a single file's metadata + download URL right before uploading.
  // Source systems (Canvas) issue pre-signed URLs that expire in ~1h, so the upload
  // worker must refetch rather than rely on a URL captured during discovery.
  // Returns null if the source system no longer exposes the file.
  getFile(courseExternalId: string, fileExternalId: string): Promise<DiscoveredFile | null>;

  // Stream the file bytes — callers pipe directly to S3 multipart upload to avoid
  // buffering large files in memory.
  downloadFileStream(downloadUrl: string): Promise<Readable>;
}
