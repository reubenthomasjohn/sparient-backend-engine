import prisma from '../../db/client';
import { BatchBuilder } from '../sync/BatchBuilder';
import { uploadQueue } from '../../queue';
import { logger } from '../../utils/logger';

export class RetryService {
  private readonly batchBuilder = new BatchBuilder();

  async runRetryPass(): Promise<void> {
    logger.info('RetryService: starting pass');

    const now = new Date();
    const eligible = await prisma.sourceFile.findMany({
      where: {
        lastOutcome: 'failed',
        nextRetryAt: { lte: now },
      },
      include: { course: { include: { institution: true } } },
    });

    if (eligible.length === 0) {
      logger.info('RetryService: no eligible files');
      return;
    }

    // Two failure shapes need different treatment:
    //   - no s3_source_key  → upload never succeeded; re-enqueue upload
    //   - s3_source_key set → remediation failed; clear the in-flight pin so BatchBuilder re-picks it
    const needUpload = eligible.filter((f) => !f.s3SourceKey);
    const needBatch = eligible.filter((f) => f.s3SourceKey);

    for (const f of needUpload) {
      await uploadQueue.send({
        sourceFileId: f.id,
        modifiedAtMs: f.discoveredModifiedAt.getTime(),
      });
    }
    if (needUpload.length > 0) {
      logger.info('RetryService: re-enqueued uploads', { count: needUpload.length });
    }

    if (needBatch.length > 0) {
      // Clear the pin and the terminal outcome so the file is eligible again.
      await prisma.sourceFile.updateMany({
        where: { id: { in: needBatch.map((f) => f.id) } },
        data: { lastOutcome: null, batchedModifiedAt: null, nextRetryAt: null },
      });

      const byCourse = new Map<string, typeof needBatch>();
      for (const f of needBatch) {
        const arr = byCourse.get(f.courseId) ?? [];
        arr.push(f);
        byCourse.set(f.courseId, arr);
      }

      for (const [courseId, files] of byCourse) {
        try {
          const c = files[0].course;
          await this.batchBuilder.buildForCourse(c.institution, c, { isRetry: true });
        } catch (err) {
          logger.error('RetryService: retry batch failed', { courseId, error: err });
        }
      }
    }
  }
}
