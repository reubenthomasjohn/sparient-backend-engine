import { Course, FileStatus, SourceFile } from '@prisma/client';
import { DiscoveredFile } from '../../types/source';
import prisma from '../../db/client';
import { logger } from '../../utils/logger';

// Statuses in which a re-upload should be queued but processing must not be interrupted
const IN_FLIGHT_STATUSES: FileStatus[] = ['batched'];

// Statuses from which we never auto-retry (operator must intervene)
const TERMINAL_STATUSES: FileStatus[] = ['permanently_failed'];

export interface ChangeDetectionResult {
  toUpload: DiscoveredFile[];   // new or changed files that need to be pulled from Canvas + uploaded to S3
  toDelete: string[];           // canvas_file_ids no longer returned by Canvas
}

export class FileChangeDetector {
  async detect(course: Course, discoveredFiles: DiscoveredFile[]): Promise<ChangeDetectionResult> {
    const existingFiles = await prisma.sourceFile.findMany({
      where: { courseId: course.id },
    });

    const existingByExternalId = new Map<string, SourceFile>(
      existingFiles.map((f) => [f.canvasFileId, f]),
    );

    const discoveredExternalIds = new Set(discoveredFiles.map((f) => f.externalId));
    const toUpload: DiscoveredFile[] = [];

    for (const discovered of discoveredFiles) {
      const existing = existingByExternalId.get(discovered.externalId);

      if (!existing) {
        // Brand new file — create a record and queue for upload
        await prisma.sourceFile.create({
          data: {
            courseId: course.id,
            canvasFileId: discovered.externalId,
            displayName: discovered.displayName,
            fileName: discovered.fileName,
            mimeType: discovered.mimeType,
            sizeBytes: discovered.sizeBytes,
            canvasModifiedAt: discovered.modifiedAt,
            status: 'pending',
          },
        });
        toUpload.push(discovered);
        logger.info('FileChangeDetector: new file queued', { externalId: discovered.externalId });
        continue;
      }

      // Skip files we ourselves wrote back to Canvas (loop prevention)
      if (
        existing.lastWritebackModifiedAt &&
        discovered.modifiedAt.getTime() === existing.lastWritebackModifiedAt.getTime()
      ) {
        logger.info('FileChangeDetector: skipping own writeback', {
          externalId: discovered.externalId,
        });
        continue;
      }

      // No content change
      if (discovered.modifiedAt <= existing.canvasModifiedAt) {
        logger.info('FileChangeDetector: unchanged, skipping', {
          externalId: discovered.externalId,
          status: existing.status,
          canvasModifiedAt: existing.canvasModifiedAt,
          discoveredModifiedAt: discovered.modifiedAt,
        });
        continue;
      }

      // Content changed — handle based on current status
      if (TERMINAL_STATUSES.includes(existing.status)) {
        logger.warn('FileChangeDetector: changed file is permanently failed, skipping', {
          fileId: existing.id,
        });
        continue;
      }

      if (IN_FLIGHT_STATUSES.includes(existing.status)) {
        // Mark for resubmission after the in-flight batch completes
        await prisma.sourceFile.update({
          where: { id: existing.id },
          data: {
            pendingResubmit: true,
            canvasModifiedAt: discovered.modifiedAt,
          },
        });
        // Still upload the new version to S3 — versioning preserves the copy Connectivo is processing
        toUpload.push(discovered);
        logger.info('FileChangeDetector: file changed during processing, flagged for resubmit', {
          fileId: existing.id,
        });
        continue;
      }

      // All other statuses: reset and re-queue
      await prisma.sourceFile.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          canvasModifiedAt: discovered.modifiedAt,
          pendingResubmit: false,
          retryCount: 0,
          nextRetryAt: null,
          lastFailureReason: null,
        },
      });
      toUpload.push(discovered);
      logger.info('FileChangeDetector: file changed, re-queued', { fileId: existing.id });
    }

    // Files in our DB that Canvas no longer returns
    const toDelete = existingFiles
      .filter(
        (f) =>
          !discoveredExternalIds.has(f.canvasFileId) &&
          f.status !== 'deleted_from_source',
      )
      .map((f) => f.canvasFileId);

    return { toUpload, toDelete };
  }
}
