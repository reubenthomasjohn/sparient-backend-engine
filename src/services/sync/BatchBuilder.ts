import { Batch, Course, Institution, SourceFile } from '@prisma/client';
import prisma from '../../db/client';
import { requestPublisher } from '../remediation/RequestPublisher';
import { computeFailureUpdate } from '../../utils/failure';
import { Errors } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface BuildOptions {
  isInitialSync?: boolean;
  isRetry?: boolean;
  forceReprocess?: boolean;
  s3Bucket: string;
}

export interface BuildForFileResult {
  batchId: string;
  wasAlreadyInFlight: boolean;
}

export class BatchBuilder {
  async buildForCourse(
    institution: Institution,
    course: Course,
    options: BuildOptions,
  ): Promise<Batch | null> {
    // Pull potentially-eligible files, then filter the cross-column condition in JS.
    const candidates = await prisma.sourceFile.findMany({
      where: {
        courseId: course.id,
        s3SourceKey: { not: null },
        s3SourceModifiedAt: { not: null },
        OR: [
          { lastOutcome: null },
          { lastOutcome: { notIn: ['deleted', 'permanently_failed'] } },
        ],
      },
    });

    const eligible = candidates.filter(
      (f) =>
        f.batchedModifiedAt === null ||
        f.s3SourceModifiedAt!.getTime() > f.batchedModifiedAt.getTime(),
    );

    if (eligible.length === 0) return null;

    // Single transaction: claim files + create batch + create batch_files.
    // If any step fails or the process crashes, everything rolls back together.
    // No orphaned claims possible.
    const result = await prisma.$transaction(async (tx) => {
      const claimed: SourceFile[] = [];
      for (const file of eligible) {
        const { count } = await tx.sourceFile.updateMany({
          where: {
            id: file.id,
            OR: [
              { batchedModifiedAt: null },
              { batchedModifiedAt: { lt: file.s3SourceModifiedAt! } },
            ],
          },
          data: {
            batchedModifiedAt: file.s3SourceModifiedAt!,
            lastOutcome: null,
            lastFailureReason: null,
          },
        });
        if (count === 1) claimed.push(file);
      }

      if (claimed.length === 0) return null;

      const batch = await tx.batch.create({
        data: {
          institutionId: institution.id,
          courseId: course.id,
          status: 'pending',
          isInitialSync: options.isInitialSync ?? false,
          isRetry: options.isRetry ?? false,
          totalFiles: claimed.length,
        },
      });

      await tx.batchFile.createMany({
        data: claimed.map((f) => ({
          batchId: batch.id,
          sourceFileId: f.id,
          canvasFileId: f.canvasFileId,
          s3SourceKey: f.s3SourceKey!,
          sourceModifiedAt: f.s3SourceModifiedAt!,
        })),
      });

      return { batch, claimed };
    });

    if (!result) return null;

    const { batch, claimed } = result;

    logger.info('BatchBuilder: batch created', {
      batchId: batch.id,
      courseId: course.id,
      fileCount: claimed.length,
      ...options,
    });

    // Publish request.json to S3. If this fails, roll back the claim AND record
    // the failure properly (incrementing retryCount via computeFailureUpdate).
    try {
      await requestPublisher.publish(batch, institution, course, options.s3Bucket, options.forceReprocess ?? options.isRetry ?? false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('BatchBuilder: request publish failed, rolling back', {
        batchId: batch.id,
        error: reason,
      });
      for (const file of claimed) {
        const fu = computeFailureUpdate(file, `Request publish failed: ${reason}`);
        await prisma.sourceFile.update({ where: { id: file.id }, data: { ...fu, batchedModifiedAt: null } });
      }
      await prisma.batch.update({
        where: { id: batch.id },
        data: { status: 'failed' },
      });
      return null;
    }

    return batch;
  }

  // Atomic single-file batch creation for the on-demand "remediate this one
  // file" trigger. Caller must have ensured the source file is upload-ready
  // (s3SourceKey and s3SourceModifiedAt populated by handleUploadJob).
  //
  // Why this exists separately from buildForCourse: buildForCourse claims
  // every eligible file in the course, which is wrong for a single-file
  // trigger (the UI would get a multi-file batchId). It also does not
  // serialize with concurrent buildForCourse calls — it relies on an
  // optimistic CAS on batched_modified_at. The trigger flow clears that
  // column to null mid-flow, and a buildForCourse run that interleaves
  // can claim the file at the old s3_source_modified_at; the trigger's
  // own claim then runs at the bumped s3_source_modified_at, putting the
  // same row in two pending batches and double-billing Connectivo.
  //
  // The SELECT FOR UPDATE inside the transaction below closes that window:
  // any concurrent buildForCourse.updateMany on the same row blocks until
  // we commit. We either find an existing pending batch and return its
  // id, or claim the row and create a single-file batch.
  async buildForFile(
    institution: Institution,
    course: Course,
    sourceFile: SourceFile,
    options: BuildOptions,
  ): Promise<BuildForFileResult> {
    if (sourceFile.s3SourceKey === null || sourceFile.s3SourceModifiedAt === null) {
      throw new Error(
        `buildForFile: sourceFile ${sourceFile.id} is missing s3SourceKey or s3SourceModifiedAt — ` +
        `caller must complete the upload before calling buildForFile.`,
      );
    }

    const claim = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM source_files WHERE id = ${sourceFile.id} FOR UPDATE`;

      const inFlight = await tx.batchFile.findFirst({
        where: { sourceFileId: sourceFile.id, batch: { status: 'pending' } },
        orderBy: { createdAt: 'desc' },
        select: { batchId: true },
      });
      if (inFlight) {
        return { kind: 'inFlight' as const, batchId: inFlight.batchId };
      }

      await tx.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          batchedModifiedAt: sourceFile.s3SourceModifiedAt!,
          lastOutcome: null,
          lastFailureReason: null,
        },
      });

      const batch = await tx.batch.create({
        data: {
          institutionId: institution.id,
          courseId: course.id,
          status: 'pending',
          isInitialSync: options.isInitialSync ?? false,
          isRetry: options.isRetry ?? false,
          totalFiles: 1,
        },
      });

      await tx.batchFile.create({
        data: {
          batchId: batch.id,
          sourceFileId: sourceFile.id,
          canvasFileId: sourceFile.canvasFileId,
          s3SourceKey: sourceFile.s3SourceKey!,
          sourceModifiedAt: sourceFile.s3SourceModifiedAt!,
        },
      });

      return { kind: 'created' as const, batchId: batch.id, batch };
    });

    if (claim.kind === 'inFlight') {
      logger.info('BatchBuilder: single-file trigger caught pre-existing in-flight batch', {
        sourceFileId: sourceFile.id,
        batchId: claim.batchId,
      });
      return { batchId: claim.batchId, wasAlreadyInFlight: true };
    }

    logger.info('BatchBuilder: single-file batch created', {
      batchId: claim.batchId,
      courseId: course.id,
      sourceFileId: sourceFile.id,
      forceReprocess: options.forceReprocess ?? false,
    });

    // Publish outside the transaction (S3 latency). Mirror buildForCourse's
    // rollback shape on publish failure: revert the claim via
    // computeFailureUpdate and mark the batch failed so the next scheduled
    // sync re-attempts. Surface the failure to the caller as a 502 — unlike
    // buildForCourse's null-return semantics, the single-file trigger is
    // user-driven and the UI needs to see the error.
    try {
      await requestPublisher.publish(claim.batch, institution, course, options.s3Bucket, options.forceReprocess ?? false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('BatchBuilder: single-file publish failed, rolling back', {
        batchId: claim.batchId,
        sourceFileId: sourceFile.id,
        error: reason,
      });
      const fu = computeFailureUpdate(sourceFile, `Request publish failed: ${reason}`);
      await prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: { ...fu, batchedModifiedAt: null },
      });
      await prisma.batch.update({
        where: { id: claim.batchId },
        data: { status: 'failed' },
      });
      throw Errors.badGateway(
        `Failed to publish remediation request for '${sourceFile.fileName}': ${reason}. ` +
        `The file will be retried automatically by the next scheduled sync.`,
      );
    }

    return { batchId: claim.batchId, wasAlreadyInFlight: false };
  }
}
