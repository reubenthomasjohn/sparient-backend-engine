import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import prisma from '../../db/client';
import { discoveryQueue } from '../../queue';
import { config } from '../../config';
import { getBucketName } from '../../config/s3Bucket';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/errors';
import { SourceRegistry } from '../sources/SourceRegistry';
import { BatchBuilder } from './BatchBuilder';
import { getEffectiveSyncConfig } from './syncConfig';

const sfn = new SFNClient({ region: config.aws.region });
const batchBuilder = new BatchBuilder();

// Hard endpoint-level size cap for the inline single-file trigger. The flow runs
// in the API Lambda (30s budget); a Canvas download + S3 upload + request publish
// for a file much larger than this won't finish in time. Callers with bigger files
// fall through to the scheduled sync (Step Functions, no per-file timeout).
const SINGLE_FILE_TRIGGER_SIZE_CAP_BYTES = 100 * 1024 * 1024;

export class SyncOrchestrator {
  async syncInstitution(institutionId: string, force?: boolean): Promise<void> {
    await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    await discoveryQueue.send({ type: 'discover', institutionId, force });
    logger.info('SyncOrchestrator: institution discover enqueued', { institutionId, force });
  }

  async syncCourse(institutionId: string, canvasCourseId: string, force?: boolean): Promise<void> {
    const institution = await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });

    if (!config.aws.courseWorkflowArn) {
      // Local dev fallback
      const { discoverFiles, batchPublish } = await import('../../workers/course/handler');
      const s3Bucket = getBucketName(institutionId, institution.s3Bucket);
      const course = await prisma.course.findFirst({
        where: { institutionId, canvasCourseId },
      });
      const result = await discoverFiles({
        step: 'discover-files',
        institutionId,
        s3Bucket,
        canvasCourseId,
        courseId: course?.id ?? '',
        force,
      });
      if (result.hasWork) {
        await batchPublish({
          step: 'batch-publish',
          institutionId,
          s3Bucket,
          canvasCourseId,
          courseId: result.courseId,
          isInitialSync: result.isInitialSync,
          force,
        });
      }
      return;
    }

    await sfn.send(new StartExecutionCommand({
      stateMachineArn: config.aws.courseWorkflowArn,
      name: `${institutionId}-${canvasCourseId}-${Date.now()}`,
      input: JSON.stringify({
        institutionId,
        force: force ?? false,
        singleCourseId: canvasCourseId,
      }),
    }));

    logger.info('SyncOrchestrator: single course SFN started', { institutionId, canvasCourseId, force });
  }

  // Trigger remediation for a single file on demand. Inline (not via SFN) — the
  // primitives (upload handler + BatchBuilder) are plain functions, and the UI
  // wants `batchId` synchronously. Bounded by the API Lambda's 30s timeout via
  // SINGLE_FILE_TRIGGER_SIZE_CAP_BYTES.
  async syncFile(
    institutionId: string,
    canvasCourseId: string,
    canvasFileId: string,
    force: boolean,
  ): Promise<{ batchId: string | null; sourceFileId: string; wasAlreadyInFlight: boolean }> {
    const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
    if (!institution) throw Errors.notFound('Institution');

    const course = await prisma.course.findUnique({
      where: { institutionId_canvasCourseId: { institutionId, canvasCourseId } },
    });
    if (!course) throw Errors.notFound('Course');

    // In-flight check: if this file is already in a pending batch (e.g. the
    // scheduled sync just claimed it), return that batchId rather than creating
    // a duplicate batch. UI polls the same batchId either way.
    const existingRow = await prisma.sourceFile.findUnique({
      where: { courseId_canvasFileId: { courseId: course.id, canvasFileId } },
    });
    if (existingRow) {
      const inFlight = await prisma.batchFile.findFirst({
        where: { sourceFileId: existingRow.id, batch: { status: 'pending' } },
        orderBy: { createdAt: 'desc' },
        select: { batchId: true },
      });
      if (inFlight) {
        logger.info('SyncOrchestrator: single-file trigger — already in flight', {
          institutionId, canvasCourseId, canvasFileId, batchId: inFlight.batchId,
        });
        return { batchId: inFlight.batchId, sourceFileId: existingRow.id, wasAlreadyInFlight: true };
      }
    }

    const sourceClient = SourceRegistry.getClient(institution);
    const fresh = await sourceClient.getFile(canvasCourseId, canvasFileId);
    if (!fresh) throw Errors.notFound('File in Canvas');

    if (fresh.sizeBytes !== null && fresh.sizeBytes > SINGLE_FILE_TRIGGER_SIZE_CAP_BYTES) {
      const sizeMb = (fresh.sizeBytes / 1024 / 1024).toFixed(1);
      const capMb = SINGLE_FILE_TRIGGER_SIZE_CAP_BYTES / 1024 / 1024;
      throw Errors.badRequest(
        `File '${fresh.fileName}' is ${sizeMb} MB, which exceeds the ${capMb} MB inline trigger limit. ` +
        `Files larger than ${capMb} MB are processed by the scheduled sync (no per-file size limit). ` +
        `Wait for the next sync window, or trigger a course-level sync via ` +
        `POST /sync/institutions/${institutionId}/courses/${canvasCourseId}.`,
      );
    }

    const effective = getEffectiveSyncConfig(institution);
    // Canvas can return mime types with charset/parameter suffixes
    // ("text/plain; charset=utf-8"). Strip the suffix and lowercase to align
    // with the bare strings in FILE_TYPE_REGISTRY before checking the allowlist.
    const baseMime = fresh.mimeType.split(';')[0].trim().toLowerCase();
    if (!effective.allowedMimeTypes.includes(baseMime)) {
      throw Errors.badRequest(
        `File type '${baseMime}' is not in this institution's allowedFileTypes ` +
        `(${effective.allowedFileTypes.join(', ')}). Update syncConfig.allowedFileTypes to include it.`,
      );
    }
    if (
      effective.maxFileSizeBytes !== null &&
      fresh.sizeBytes !== null &&
      fresh.sizeBytes > effective.maxFileSizeBytes
    ) {
      throw Errors.badRequest(
        `File size ${fresh.sizeBytes} bytes exceeds this institution's ` +
        `syncConfig.maxFileSizeBytes (${effective.maxFileSizeBytes}).`,
      );
    }

    // Upsert source_file row. Mirrors the create/update logic in
    // FileChangeDetector.detect for the single-file path.
    const isNewer = !existingRow || fresh.modifiedAt > existingRow.discoveredModifiedAt;
    const wasDeleted = existingRow?.lastOutcome === 'deleted';

    let sourceFile;
    if (!existingRow) {
      // New row — no in-flight batch possible, no race to guard against.
      sourceFile = await prisma.sourceFile.create({
        data: {
          courseId: course.id,
          canvasFileId,
          displayName: fresh.displayName,
          fileName: fresh.fileName,
          mimeType: fresh.mimeType,
          sizeBytes: fresh.sizeBytes,
          discoveredModifiedAt: fresh.modifiedAt,
        },
      });
    } else {
      // Existing row — race risk: BatchBuilder.buildForCourse runs in a single
      // transaction that (1) claims rows via updateMany on batched_modified_at
      // and (2) inserts batch_files. Between those, the early in-flight check
      // above can read no batch_files (READ COMMITTED hides the uncommitted
      // insert) and we'd then clear batched_modified_at, letting our own
      // BatchBuilder re-claim and double-batch the file.
      //
      // SELECT ... FOR UPDATE serializes us against the BatchBuilder
      // transaction on the same row: we either go first (BatchBuilder waits,
      // sees our batched_modified_at clear, re-evaluates eligibility), or
      // we go second (we wait for commit, then see the just-inserted
      // batch_files row and bail to the in-flight return).
      const txResult = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM source_files WHERE id = ${existingRow.id} FOR UPDATE`;

        const inFlight = await tx.batchFile.findFirst({
          where: { sourceFileId: existingRow.id, batch: { status: 'pending' } },
          orderBy: { createdAt: 'desc' },
          select: { batchId: true },
        });
        if (inFlight) {
          return { kind: 'inFlight' as const, batchId: inFlight.batchId };
        }

        const updated = await tx.sourceFile.update({
          where: { id: existingRow.id },
          data: {
            displayName: fresh.displayName,
            fileName: fresh.fileName,
            mimeType: fresh.mimeType,
            sizeBytes: fresh.sizeBytes,
            ...(isNewer || wasDeleted
              ? {
                  ...(isNewer ? { discoveredModifiedAt: fresh.modifiedAt } : {}),
                  lastOutcome: null,
                  lastFailureReason: null,
                  retryCount: 0,
                  nextRetryAt: null,
                }
              : {}),
            // force=true clears batched_modified_at so BatchBuilder re-claims
            // even when S3 content is unchanged. Safe under the row lock above.
            ...(force ? { batchedModifiedAt: null } : {}),
          },
        });
        return { kind: 'updated' as const, sourceFile: updated };
      });

      if (txResult.kind === 'inFlight') {
        logger.info('SyncOrchestrator: single-file trigger — caught in-flight batch via row-locked check', {
          institutionId, canvasCourseId, canvasFileId, batchId: txResult.batchId,
        });
        return {
          batchId: txResult.batchId,
          sourceFileId: existingRow.id,
          wasAlreadyInFlight: true,
        };
      }
      sourceFile = txResult.sourceFile;
    }

    const s3Bucket = getBucketName(institution.id, institution.s3Bucket);

    const { handleUploadJob } = await import('../../workers/upload/handler');
    await handleUploadJob({
      sourceFileId: sourceFile.id,
      modifiedAtMs: sourceFile.discoveredModifiedAt.getTime(),
      s3Bucket,
    });

    // Re-read after upload to catch the two paths where handleUploadJob
    // returns normally but didn't actually leave the row ready to batch:
    //   (1) upload failed — handleUploadJob caught the error and recorded
    //       last_outcome = failed/permanently_failed. s3_source_key may be
    //       stale or null. BatchBuilder would silently filter out → null
    //       batchId with success: true, masking the failure from the UI.
    //   (2) Canvas had a newer modified_at when handleUploadJob refreshed
    //       than when we did, so it deferred — wrote the new
    //       discovered_modified_at and returned without uploading. Our
    //       s3_source_modified_at still reflects the previous version, so
    //       BatchBuilder would batch the stale file under a misleading
    //       "freshly remediated" pretense.
    const postUpload = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: sourceFile.id },
    });
    if (postUpload.lastOutcome === 'deleted') {
      // Canvas 404'd inside handleUploadJob after passing our earlier getFile — the
      // file was removed between our entry check and the upload refresh.
      throw Errors.notFound('File in Canvas');
    }
    if (postUpload.lastOutcome === 'failed' || postUpload.lastOutcome === 'permanently_failed') {
      throw Errors.badGateway(
        `Upload to S3 failed for '${fresh.fileName}': ${postUpload.lastFailureReason ?? 'unknown reason'}. ` +
        `The file will be retried automatically by the next scheduled sync.`,
      );
    }
    if (
      postUpload.s3SourceModifiedAt === null ||
      postUpload.discoveredModifiedAt.getTime() > postUpload.s3SourceModifiedAt.getTime()
    ) {
      throw Errors.conflict(
        `Canvas reported a newer version of '${fresh.fileName}' during upload — the trigger ran ` +
        `against a stale snapshot. Retry the request to remediate the latest version.`,
      );
    }

    const batch = await batchBuilder.buildForCourse(institution, course, {
      isInitialSync: false,
      forceReprocess: force,
      s3Bucket,
    });

    logger.info('SyncOrchestrator: single-file trigger complete', {
      institutionId,
      canvasCourseId,
      canvasFileId,
      sourceFileId: sourceFile.id,
      batchId: batch?.id ?? null,
    });

    return {
      batchId: batch?.id ?? null,
      sourceFileId: sourceFile.id,
      wasAlreadyInFlight: false,
    };
  }
}
