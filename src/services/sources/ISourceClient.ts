import { DiscoveredCourse, DiscoveredFile } from '../../types/source';

export interface ISourceClient {
  getCourses(): Promise<DiscoveredCourse[]>;
  getFiles(courseExternalId: string, lastSyncedAt: Date | null): Promise<DiscoveredFile[]>;
  downloadFile(downloadUrl: string): Promise<Buffer>;
}
