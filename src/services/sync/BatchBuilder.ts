import { Batch, Course, Institution, SourceFile } from '@prisma/client';
import prisma from '../../db/client';
import { logger } from '../../utils/logger';

export class BatchBuilder {
  async createBatch(
    institution: Institution,
    course: Course,
    readyFiles: SourceFile[],
    options: { isInitialSync?: boolean; isRetry?: boolean } = {},
  ): Promise<Batch> {
    logger.info('BatchBuilder: creating batch', {
      institutionId: institution.id,
      courseId: course.id,
      fileCount: readyFiles.length,
      ...options,
    });

    const batch = await prisma.$transaction(async (tx) => {
      const newBatch = await tx.batch.create({
        data: {
          institutionId: institution.id,
          courseId: course.id,
          status: 'pending',
          isInitialSync: options.isInitialSync ?? false,
          isRetry: options.isRetry ?? false,
          totalFiles: readyFiles.length,
        },
      });

      await tx.batchFile.createMany({
        data: readyFiles.map((file) => ({
          batchId: newBatch.id,
          sourceFileId: file.id,
        })),
      });

      // Transition files to processing status
      await tx.sourceFile.updateMany({
        where: { id: { in: readyFiles.map((f) => f.id) } },
        data: { status: 'processing' },
      });

      return newBatch;
    });

    logger.info('BatchBuilder: batch created', { batchId: batch.id });
    return batch;
  }
}
