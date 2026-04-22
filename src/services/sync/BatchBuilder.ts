import { Batch, Course, Institution, SourceFile } from '@prisma/client';
import prisma from '../../db/client';
import { requestPublisher } from '../remediation/RequestPublisher';
import { computeFailureUpdate } from '../../utils/failure';
import { logger } from '../../utils/logger';

export interface BuildOptions {
  isInitialSync?: boolean;
  isRetry?: boolean;
  forceReprocess?: boolean;
}

export class BatchBuilder {
  async buildForCourse(
    institution: Institution,
    course: Course,
    options: BuildOptions = {},
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
      await requestPublisher.publish(batch, institution, course, options.forceReprocess ?? options.isRetry ?? false);
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
}
