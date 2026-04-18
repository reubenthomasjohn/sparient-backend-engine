import { CanvasClient } from './CanvasClient';
import { s3Service } from '../../storage/S3Service';
import {
  DiscoveredFile,
  ReplaceFileParams,
  SupersedeFileParams,
  UploadNewFileParams,
} from '../../../types/source';
import { CanvasFile } from '../../../types/canvas';
import { logger } from '../../../utils/logger';

// Handles pushing bytes from the source S3 bucket back into Canvas. The three modes
// differ only in how they derive the upload's (folder, name, on_duplicate) tuple:
//
//   - replaceFile:   look up the old file → reuse its folder + name + overwrite
//                    (Canvas keeps the same file id; UI shows updated mtime only —
//                    Canvas does not expose version history)
//   - uploadNewFile: caller-supplied folder + name + rename (new file id)
//   - supersedeFile: old file's folder + new name + rename, then delete the old
export class CanvasFileReplacer {
  constructor(private readonly client: CanvasClient) {}

  async replaceFile(params: ReplaceFileParams): Promise<DiscoveredFile> {
    const existing = await this.client.getFile(params.replacesFileExternalId);

    logger.info('Canvas: replacing file in place', {
      fileId: existing.id,
      folderId: existing.folder_id,
      fileName: existing.filename,
    });

    const courseId = await this.courseIdFromFile(existing);
    const body = await s3Service.getSourceFileBytes(params.s3Key);
    const uploaded = await this.client.uploadCourseFile(body, {
      courseId,
      fileName: existing.filename,
      sizeBytes: body.byteLength,
      mimeType: params.mimeType,
      parentFolderId: existing.folder_id.toString(),
      onDuplicate: 'overwrite',
    });

    return toDiscovered(uploaded);
  }

  async uploadNewFile(params: UploadNewFileParams): Promise<DiscoveredFile> {
    const body = await s3Service.getSourceFileBytes(params.s3Key);
    const uploaded = await this.client.uploadCourseFile(body, {
      courseId: params.courseExternalId,
      fileName: params.fileName,
      sizeBytes: body.byteLength,
      mimeType: params.mimeType,
      parentFolderId: params.parentFolderId,
      onDuplicate: 'rename',
    });

    return toDiscovered(uploaded);
  }

  async supersedeFile(params: SupersedeFileParams): Promise<DiscoveredFile> {
    const existing = await this.client.getFile(params.replacesFileExternalId);

    const courseId = await this.courseIdFromFile(existing);
    const body = await s3Service.getSourceFileBytes(params.s3Key);
    const uploaded = await this.client.uploadCourseFile(body, {
      courseId,
      fileName: params.fileName,
      sizeBytes: body.byteLength,
      mimeType: params.mimeType,
      parentFolderId: existing.folder_id.toString(),
      // rename, not overwrite — a name collision here (other than with `existing`
      // itself) must not silently clobber an unrelated file
      onDuplicate: 'rename',
    });

    // Only delete after upload succeeds — on failure the old file remains the source of truth.
    await this.client.deleteFile(params.replacesFileExternalId);

    return toDiscovered(uploaded);
  }

  // Canvas's file object doesn't surface course_id directly — it only has folder_id
  // and the folder carries the context. For the upload API we need the course id, so
  // we fetch the folder to read context_id. context_type is "Course" for course files.
  private async courseIdFromFile(file: CanvasFile): Promise<string> {
    const folder = await this.client.getFolder(file.folder_id.toString());
    if (folder.context_type !== 'Course') {
      throw new Error(`Cannot upload: file ${file.id} is not in a course context`);
    }
    return folder.context_id.toString();
  }
}

function toDiscovered(f: CanvasFile): DiscoveredFile {
  return {
    externalId: f.id.toString(),
    displayName: f.display_name,
    fileName: f.filename,
    mimeType: f['content-type'],
    sizeBytes: f.size ?? null,
    modifiedAt: new Date(f.modified_at),
    downloadUrl: f.url,
  };
}
