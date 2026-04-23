import prisma from '../../db/client';
import { UploadJob } from '../../queue';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { s3Service } from '../../services/storage/S3Service';
import { computeFailureUpdate } from '../../utils/failure';
import { logger } from '../../utils/logger';
export async function handleUploadJob(job: UploadJob): Promise<void> {
  const row = await prisma.sourceFile.findUnique({
    where: { id: job.sourceFileId },
    include: { course: { include: { institution: true } } },
  });

  if (!row) {
    logger.warn('Upload: source_file not found, dropping message', { job });
    return;
  }

  // Stale-message guard: discovery has since seen a newer version. A fresher message
  // is already in the queue — drop this one rather than upload an outdated version.
  if (row.discoveredModifiedAt.getTime() > job.modifiedAtMs) {
    logger.info('Upload: stale message, newer version already discovered', {
      sourceFileId: row.id,
      messageMs: job.modifiedAtMs,
      rowMs: row.discoveredModifiedAt.getTime(),
    });
    return;
  }

  // Idempotent no-op: this exact version is already uploaded.
  if (row.s3SourceModifiedAt && row.s3SourceModifiedAt.getTime() >= job.modifiedAtMs) {
    logger.info('Upload: already uploaded, no-op', { sourceFileId: row.id });
    return;
  }

  const sourceClient = SourceRegistry.getClient(row.course.institution);

  // Refresh metadata right before download — Canvas pre-signed URLs expire quickly
  // and the URL captured at discovery time may have gone stale while the message sat in SQS.
  const fresh = await sourceClient.getFile(row.course.canvasCourseId, row.canvasFileId);

  if (!fresh) {
    await prisma.sourceFile.update({
      where: { id: row.id },
      data: { lastOutcome: 'deleted' },
    });
    logger.info('Upload: file gone from Canvas, marked deleted', { sourceFileId: row.id });
    return;
  }

  // Canvas already reports a newer version than the message was for. Record the newer
  // discoveredModifiedAt and wait for the next discovery pass to enqueue the correct job —
  // we don't want to upload a version we were never asked for.
  const canvasMs = fresh.modifiedAt.getTime();
  if (canvasMs > job.modifiedAtMs) {
    await prisma.sourceFile.updateMany({
      where: {
        id: row.id,
        OR: [
          { discoveredModifiedAt: { lt: fresh.modifiedAt } },
        ],
      },
      data: {
        discoveredModifiedAt: fresh.modifiedAt,
        lastOutcome: null,
        lastFailureReason: null,
        retryCount: 0,
        nextRetryAt: null,
      },
    });
    logger.info('Upload: Canvas has newer version, deferring', {
      sourceFileId: row.id,
      messageMs: job.modifiedAtMs,
      canvasMs,
    });
    return;
  }

  // Content-addressed: modifiedAt is in the key, so in-flight S3 objects are never clobbered.
  const s3Key = s3Service.buildSourceKey({
    canvasCourseId: row.course.canvasCourseId,
    canvasFileId: row.canvasFileId,
    modifiedAt: fresh.modifiedAt,
    fileName: fresh.fileName,
  });

  try {
    const stream = await sourceClient.downloadFileStream(fresh.downloadUrl);
    await s3Service.uploadSourceFileStream(job.s3Bucket, s3Key, stream, fresh.mimeType);

    // Strictly monotonic update — if a parallel worker with a newer modifiedAt already
    // advanced s3_source_modified_at, this no-ops rather than regressing the pointer.
    const { count } = await prisma.sourceFile.updateMany({
      where: {
        id: row.id,
        OR: [
          { s3SourceModifiedAt: null },
          { s3SourceModifiedAt: { lt: fresh.modifiedAt } },
        ],
      },
      data: {
        s3SourceKey: s3Key,
        s3SourceBucket: job.s3Bucket,
        s3SourceModifiedAt: fresh.modifiedAt,
      },
    });

    if (count === 0) {
      logger.info('Upload: newer version already recorded, keeping S3 object only', {
        sourceFileId: row.id,
      });
      return;
    }

    logger.info('Upload: success', { sourceFileId: row.id, s3Key });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fu = computeFailureUpdate(row, reason);
    await prisma.sourceFile.update({ where: { id: row.id }, data: fu });
    logger.error('Upload: failed', { sourceFileId: row.id, error: reason });
  }
}
