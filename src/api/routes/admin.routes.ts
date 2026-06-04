import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../db/client';
import { handleResponseJob } from '../../workers/responses/handler';
import { RemediationService } from '../../services/remediation/RemediationService';
import { getBucketName } from '../../config/s3Bucket';
import { Errors } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();
const remediationService = new RemediationService();

// POST /admin/responses/:institutionId/:courseId/:batchId
//
// Manual replay of a Connectivo response. Operator must have placed (or copied)
// the response.json at `<RESPONSES_PREFIX>/<batchId>.json` in the institution
// bucket. The dedup key is the S3 object key — since this convention differs
// from Connectivo's own `<timestamp>_job_completed_<batchId>.json`, a replay
// here will be treated as a new attempt and increment Batch.numRetries. If the
// same admin replay is fired twice, the second call short-circuits silently.
// To force a true re-process, delete the matching batch_responses row first.
router.post(
  '/responses/:institutionId/:courseId/:batchId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId, batchId } = req.params;
      const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
      if (!institution) throw Errors.notFound('Institution');

      const bucket = getBucketName(institutionId, institution.s3Bucket);
      const key = `${batchId}.json`;
      await handleResponseJob({ bucket, key });
      res.json({ success: true, processed: { bucket, key } });
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/institutions/:institutionId/writebacks/backfill
//
// Re-runs the idempotent writeback producer for every terminal batch belonging
// to the institution. Use case: an institution flips writebackOptIn from false →
// true and wants prior completed batches pushed to Canvas (the response handler
// short-circuits when opted-out, so those writebacks were never queued).
//
// Safe to call repeatedly: enqueueWritebacks filters out already-written,
// already-skipped, and superseded files. Files in failed batches are also
// skipped (filter requires connectivoState in ['completed', 'completed_with_warnings']).
router.post(
  '/institutions/:institutionId/writebacks/backfill',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;
      const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
      if (!institution) throw Errors.notFound('Institution');

      const terminalStatuses = ['completed', 'completed_with_warnings'] as const;
      const batches = await prisma.batch.findMany({
        where: { institutionId, status: { in: [...terminalStatuses] } },
        select: { id: true },
      });

      logger.info('Admin: starting writeback backfill', {
        institutionId,
        candidateBatches: batches.length,
      });

      let processed = 0;
      let errors = 0;
      for (const batch of batches) {
        try {
          await remediationService.enqueueWritebacks(batch.id);
          processed++;
        } catch (err) {
          errors++;
          logger.error('Admin: backfill enqueue failed for batch, continuing', {
            batchId: batch.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.json({ success: true, candidateBatches: batches.length, processed, errors });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
