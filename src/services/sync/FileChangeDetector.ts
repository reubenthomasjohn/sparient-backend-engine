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

export interface DetectOptions {
  // Current institution allowlist — used to scope deletion detection. A row
  // whose stored mimeType is OUTSIDE this set is "out of scope" not "deleted":
  // the institution narrowed allowedFileTypes after we discovered the file,
  // so the Canvas filter no longer returns it. Marking such rows deleted
  // strands them — they wouldn't reappear even if the institution re-widens
  // the allowlist (timestamps unchanged → isNewer false → no re-upload).
  // When omitted, every row is treated as in scope (legacy behavior).
  allowedMimeTypes?: Set<string>;
}

export class FileChangeDetector {
  async detect(
    course: Course,
    discovered: DiscoveredFile[],
    opts: DetectOptions = {},
  ): Promise<ChangeDetectionResult> {
    const existing = await prisma.sourceFile.findMany({
      where: { courseId: course.id },
    });
    const existingByCanvasId = new Map(existing.map((f) => [f.canvasFileId, f]));
    const discoveredIds = new Set(discovered.map((f) => f.externalId));

    const toUploadJobs: FileToUpload[] = [];

    for (const d of discovered) {
      const row = existingByCanvasId.get(d.externalId);

      // Skip files we ourselves wrote back to Canvas — their modifiedAt equals
      // what Canvas returned to us on upload completion. The `lastOutcome !==
      // 'deleted'` clause prevents a deleted file from getting stuck: if a
      // file's lastWritebackModifiedAt happens to equal d.modifiedAt AND the
      // file was previously marked deleted (e.g. allowlist narrowing then
      // re-widening), we want to fall through to the reappear-after-deleted
      // path below rather than skip.
      if (
        row?.lastWritebackModifiedAt &&
        d.modifiedAt.getTime() === row.lastWritebackModifiedAt.getTime() &&
        row.lastOutcome !== 'deleted'
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
      // Reappear-after-deleted: a file marked 'deleted' that's now in
      // discovery again. Common cause: the institution narrowed
      // allowedFileTypes (which marked the file deleted) and then re-widened
      // it. Without clearing the terminal state, the row stays stuck because
      // the timestamps haven't advanced. We clear and re-queue an upload so
      // the file rejoins the pipeline.
      const wasDeleted = row.lastOutcome === 'deleted';

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
            : wasDeleted
              ? {
                  // Don't bump discoveredModifiedAt — content hasn't changed.
                  // Clearing batchedModifiedAt is essential: the upload step
                  // is a no-op for an already-uploaded version, so without
                  // this, BatchBuilder's `batched_modified_at < s3_source_
                  // modified_at` claim filter never matches and the row sits
                  // permanently with lastOutcome:null but never gets batched.
                  lastOutcome: null,
                  lastFailureReason: null,
                  retryCount: 0,
                  nextRetryAt: null,
                  batchedModifiedAt: null,
                }
              : {}),
        },
      });

      if (isNewer || wasDeleted) {
        toUploadJobs.push({ sourceFileId: row.id, modifiedAtMs: d.modifiedAt.getTime() });
      }
    }

    // Deletion detection with two guards:
    //   1. Mass-delete guard — a silent Canvas auth/scope failure can return
    //      an empty list. Refuse to mark anything deleted in that shape.
    //   2. In-scope guard — only consider rows whose mimeType is still in the
    //      institution's current allowlist. Rows of types the institution
    //      narrowed out are out of scope (the Canvas filter excluded them),
    //      not deleted from Canvas itself.
    let deletedCount = 0;
    if (discovered.length === 0 && existing.length > 0) {
      logger.warn(
        'FileChangeDetector: Canvas returned empty list but DB has files — skipping deletes',
        { courseId: course.id, existingCount: existing.length },
      );
    } else {
      const inScope = (mimeType: string): boolean =>
        opts.allowedMimeTypes ? opts.allowedMimeTypes.has(mimeType) : true;

      const toDelete = existing.filter(
        (f) =>
          !discoveredIds.has(f.canvasFileId) && f.lastOutcome !== 'deleted' && inScope(f.mimeType),
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
