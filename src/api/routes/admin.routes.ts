import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../db/client';
import { handleResponseJob } from '../../workers/responses/handler';
import { getBucketName } from '../../config/s3Bucket';
import { Errors } from '../../utils/errors';

const router = Router();

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

export default router;
