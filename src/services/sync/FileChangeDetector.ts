import { Course } from '@prisma/client';
import { DiscoveredFile } from '../../types/source';
import prisma from '../../db/client';
import { logger } from '../../utils/logger';

export interface FileToUpload {
  sourceFileId: string;
  modifiedAtMs: number;
}

export interface ChangeDetectionResult {
  toUploadJobs: FileToUpload[];
  deletedCount: number;
}

export class FileChangeDetector {
  async detect(course: Course, discovered: DiscoveredFile[]): Promise<ChangeDetectionResult> {
    const existing = await prisma.sourceFile.findMany({
      where: { courseId: course.id },
    });
    const existingByCanvasId = new Map(existing.map((f) => [f.canvasFileId, f]));
    const discoveredIds = new Set(discovered.map((f) => f.externalId));

    const toUploadJobs: FileToUpload[] = [];

    for (const d of discovered) {
      const row = existingByCanvasId.get(d.externalId);

      // Skip files we ourselves wrote back to Canvas — their modifiedAt equals what
      // Canvas returned to us on upload completion.
      if (
        row?.lastWritebackModifiedAt &&
        d.modifiedAt.getTime() === row.lastWritebackModifiedAt.getTime()
      ) {
        continue;
      }

      if (!row) {
        const created = await prisma.sourceFile.create({
          data: {
            courseId: course.id,
            canvasFileId: d.externalId,
            displayName: d.displayName,
            fileName: d.fileName,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            discoveredModifiedAt: d.modifiedAt,
          },
        });
        toUploadJobs.push({ sourceFileId: created.id, modifiedAtMs: d.modifiedAt.getTime() });
        continue;
      }

      const isNewer = d.modifiedAt > row.discoveredModifiedAt;

      // Always refresh metadata so renames/resizes don't leave the UI with stale display names.
      // Advance discoveredModifiedAt and clear terminal outcome only when content actually changed.
      await prisma.sourceFile.update({
        where: { id: row.id },
        data: {
          displayName: d.displayName,
          fileName: d.fileName,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          ...(isNewer
            ? {
                discoveredModifiedAt: d.modifiedAt,
                lastOutcome: null,
                lastFailureReason: null,
                retryCount: 0,
                nextRetryAt: null,
              }
            : {}),
        },
      });

      if (isNewer) {
        toUploadJobs.push({ sourceFileId: row.id, modifiedAtMs: d.modifiedAt.getTime() });
      }
    }

    // Deletion detection with a mass-delete guard: a silent Canvas auth/scope failure can
    // return an empty list even though the course still has files. We refuse to mark
    // anything deleted in that specific shape. Genuine deletions (list returned but this
    // file isn't in it) still go through.
    let deletedCount = 0;
    if (discovered.length === 0 && existing.length > 0) {
      logger.warn(
        'FileChangeDetector: Canvas returned empty list but DB has files — skipping deletes',
        { courseId: course.id, existingCount: existing.length },
      );
    } else {
      const toDelete = existing.filter(
        (f) => !discoveredIds.has(f.canvasFileId) && f.lastOutcome !== 'deleted',
      );
      if (toDelete.length > 0) {
        await prisma.sourceFile.updateMany({
          where: { id: { in: toDelete.map((f) => f.id) } },
          data: { lastOutcome: 'deleted' },
        });
        deletedCount = toDelete.length;
      }
    }

    return { toUploadJobs, deletedCount };
  }
}
