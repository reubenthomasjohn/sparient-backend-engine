import { Readable } from 'stream';
import {
  DiscoveredCourse,
  DiscoveredFile,
  ReplaceEligibility,
  ReplaceFileParams,
  ReplaceResult,
  SupersedeFileParams,
  UploadNewFileParams,
} from '../../types/source';

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

  // Optimistic-concurrency check: can we still safely replace this file, or has the
  // source-side copy moved on since knownModifiedAt? Called standalone by UIs/workers
  // that want to pre-filter replace-ready files, and also enforced internally as a
  // guard inside replaceFile + supersedeFile so callers can't skip it.
  isFileEligibleToReplace(
    fileExternalId: string,
    knownModifiedAt: Date,
  ): Promise<ReplaceEligibility>;

  // Overwrite an existing source file in place. The implementation resolves the
  // existing file's folder + name so the source system treats this as a replacement
  // and preserves the externalId. Uploaded bytes come from s3Key in the source bucket.
  // Returns { status: 'skipped' } without uploading when isFileEligibleToReplace
  // fails — bulk callers log + continue.
  replaceFile(params: ReplaceFileParams): Promise<ReplaceResult>;

  // Upload without targeting an existing file. The source system auto-renames on a
  // name collision; returned DiscoveredFile reflects the name it actually landed
  // under. No eligibility check — this method has no anchor to a prior state.
  uploadNewFile(params: UploadNewFileParams): Promise<DiscoveredFile>;

  // Upload a new file (possibly under a new name) into the old file's folder, then
  // delete the old file. The delete is only issued if the upload succeeds. Returns
  // { status: 'skipped' } without uploading or deleting when the eligibility check
  // fails.
  supersedeFile(params: SupersedeFileParams): Promise<ReplaceResult>;
}
