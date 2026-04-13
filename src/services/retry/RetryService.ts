import prisma from '../../db/client';
import { BatchBuilder } from '../sync/BatchBuilder';
import { logger } from '../../utils/logger';

export class RetryService {
  private readonly batchBuilder = new BatchBuilder();

  async runRetryPass(): Promise<void> {
    logger.info('RetryService: starting retry pass');

    const eligibleFiles = await prisma.sourceFile.findMany({
      where: {
        status: 'failed',
        nextRetryAt: { lte: new Date() },
        retryCount: { lt: prisma.sourceFile.fields.maxRetries }, // compared per-row in application
      },
      include: { course: { include: { institution: true } } },
    });

    // Filter in application layer since maxRetries is per-row
    const toRetry = eligibleFiles.filter((f) => f.retryCount < f.maxRetries);

    if (toRetry.length === 0) {
      logger.info('RetryService: no files eligible for retry');
      return;
    }

    logger.info('RetryService: files eligible for retry', { count: toRetry.length });

    // Group by course so we create one batch per course (consistent with normal sync)
    const byCourse = new Map<string, typeof toRetry>();
    for (const file of toRetry) {
      const existing = byCourse.get(file.courseId) ?? [];
      existing.push(file);
      byCourse.set(file.courseId, existing);
    }

    for (const [courseId, files] of byCourse) {
      try {
        const course = files[0].course;
        const institution = course.institution;

        // Reset status so BatchBuilder transitions them correctly
        await prisma.sourceFile.updateMany({
          where: { id: { in: files.map((f) => f.id) } },
          data: { status: 'ready', nextRetryAt: null },
        });

        await this.batchBuilder.createBatch(institution, course, files, { isRetry: true });

        logger.info('RetryService: retry batch created', {
          courseId,
          fileCount: files.length,
        });
      } catch (err) {
        logger.error('RetryService: failed to create retry batch', { courseId, error: err });
      }
    }
  }
}
