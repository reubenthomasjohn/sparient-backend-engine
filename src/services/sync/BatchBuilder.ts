import { Batch, Course, Institution, SourceFile } from '@prisma/client';
import prisma from '../../db/client';
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
    // Cross-column comparison — Prisma's findMany can't express it, so raw SQL.
    const eligible = await prisma.$queryRaw<SourceFile[]>`
      SELECT *
      FROM source_files
      WHERE course_id = ${course.id}::uuid
        AND s3_source_key IS NOT NULL
        AND s3_source_modified_at IS NOT NULL
        AND (last_outcome IS NULL
             OR last_outcome NOT IN ('deleted', 'permanently_failed'))
        AND (batched_modified_at IS NULL
             OR s3_source_modified_at > batched_modified_at)
    `;

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

    return batch;
  }
}
