import axios from 'axios';
import { CanvasClient } from './CanvasClient';
import { toDiscoveredFile } from './mappers';
import { s3Service } from '../../storage/S3Service';
import {
  DiscoveredFile,
  ReplaceEligibility,
  ReplaceFileParams,
  ReplaceResult,
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
//
// replaceFile and supersedeFile return ReplaceResult — a 'skipped' status means the
// source-side file has moved on since knownModifiedAt and we refused to clobber it.
// Bulk callers log + continue; the method itself doesn't throw on ineligibility.
export class CanvasFileReplacer {
  constructor(private readonly client: CanvasClient) {}

  // Used standalone (pre-filter replace-ready files in a UI) and also called inside
  // replaceFile + supersedeFile so the eligibility check can't be bypassed.
  async isCanvasFileEligibleToReplace(
    fileExternalId: string,
    knownModifiedAt: Date,
  ): Promise<ReplaceEligibility> {
    let existing: CanvasFile;
    try {
      existing = await this.client.getFile(fileExternalId);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return { eligible: false, reason: 'deleted' };
      }
      throw err;
    }

    // Strict >: equal timestamps mean no drift since we observed. Canvas's modified_at
    // has second-level precision which is plenty given our sync cadence.
    const current = new Date(existing.modified_at);
    if (current.getTime() > knownModifiedAt.getTime()) {
      return { eligible: false, reason: 'modified', currentModifiedAt: current };
    }
    return { eligible: true, reason: null };
  }

  async replaceFile(params: ReplaceFileParams): Promise<ReplaceResult> {
    const eligibility = await this.isCanvasFileEligibleToReplace(
      params.fileExternalId,
      params.knownModifiedAt,
    );
    if (!eligibility.eligible && eligibility.reason) {
      this.logSkip('replace', params.fileExternalId, eligibility, params.knownModifiedAt);
      return { status: 'skipped', reason: eligibility.reason };
    }

    const existing = await this.client.getFile(params.fileExternalId);

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

    return { status: 'replaced', file: toDiscoveredFile(uploaded) };
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

    return toDiscoveredFile(uploaded);
  }

  async supersedeFile(params: SupersedeFileParams): Promise<ReplaceResult> {
    const eligibility = await this.isCanvasFileEligibleToReplace(
      params.fileExternalId,
      params.knownModifiedAt,
    );
    if (!eligibility.eligible && eligibility.reason) {
      this.logSkip('supersede', params.fileExternalId, eligibility, params.knownModifiedAt);
      return { status: 'skipped', reason: eligibility.reason };
    }

    const existing = await this.client.getFile(params.fileExternalId);

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
    await this.client.deleteFile(params.fileExternalId);

    return { status: 'replaced', file: toDiscoveredFile(uploaded) };
  }

  private logSkip(
    op: 'replace' | 'supersede',
    fileId: string,
    eligibility: ReplaceEligibility,
    knownModifiedAt: Date,
  ): void {
    if (eligibility.reason === 'modified') {
      // Both timestamps in one log line so ops can see exactly when Canvas was edited
      // between our sync and the write-back.
      logger.warn(`Canvas: skipping ${op} — file was modified in Canvas after our sync`, {
        fileId,
        knownModifiedAt: knownModifiedAt.toISOString(),
        currentModifiedAt: eligibility.currentModifiedAt?.toISOString(),
      });
    } else if (eligibility.reason === 'deleted') {
      logger.warn(`Canvas: skipping ${op} — file has been deleted from Canvas`, {
        fileId,
        knownModifiedAt: knownModifiedAt.toISOString(),
      });
    }
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
