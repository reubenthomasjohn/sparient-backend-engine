import { Batch, Course, Institution, SourceFile } from '@prisma/client';
import prisma from '../../db/client';
import { requestPublisher } from '../remediation/RequestPublisher';
import { logger } from '../../utils/logger';

export interface BuildOptions {
  isInitialSync?: boolean;
  isRetry?: boolean;
}

export class BatchBuilder {
  // Finds every source_file in the course that has a fresher S3 version than what's in-flight
  // (or no in-flight version) and atomically claims it for a new batch. The claim is a
  // conditional UPDATE — concurrent BatchBuilder calls cannot double-claim a row.
  async buildForCourse(
    institution: Institution,
    course: Course,
    options: BuildOptions = {},
  ): Promise<Batch | null> {
    // Pull every potentially-eligible file for the course, then filter the cross-column
    // condition in JS. Done this way (vs $queryRaw) because raw queries return snake_case
    // column names, and the per-course row count is small enough that the JS filter is cheap.
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

    // Atomic claim: advance batched_modified_at → s3_source_modified_at.
    // Rows another worker already claimed at the current s3_source_modified_at (or higher)
    // won't match and are silently excluded from this batch.
    const claimed: SourceFile[] = [];
    for (const file of eligible) {
      const { count } = await prisma.sourceFile.updateMany({
        where: {
          id: file.id,
          OR: [
            { batchedModifiedAt: null },
            { batchedModifiedAt: { lt: file.s3SourceModifiedAt! } },
          ],
        },
        data: { batchedModifiedAt: file.s3SourceModifiedAt! },
      });
      if (count === 1) claimed.push(file);
    }

    if (claimed.length === 0) return null;

    const batch = await prisma.$transaction(async (tx) => {
      const b = await tx.batch.create({
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
          batchId: b.id,
          sourceFileId: f.id,
          canvasFileId: f.canvasFileId,
          s3SourceKey: f.s3SourceKey!,
          sourceModifiedAt: f.s3SourceModifiedAt!,
        })),
      });

      return b;
    });

    logger.info('BatchBuilder: batch created', {
      batchId: batch.id,
      courseId: course.id,
      fileCount: claimed.length,
      ...options,
    });

    // Hand off to Connectivo by writing the per-batch request.json. If this fails,
    // roll back the claim so the files become eligible again on the next sync pass.
    try {
      await requestPublisher.publish(batch, institution, course);
    } catch (err) {
      logger.error('BatchBuilder: request publish failed, rolling back claim', {
        batchId: batch.id,
        error: err,
      });
      await prisma.sourceFile.updateMany({
        where: { id: { in: claimed.map((f) => f.id) } },
        data: { batchedModifiedAt: null },
      });
      await prisma.batch.update({
        where: { id: batch.id },
        data: { status: 'failed' },
      });
      return null;
    }

    return batch;
  }
}
