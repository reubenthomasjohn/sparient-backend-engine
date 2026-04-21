import { Router, Request, Response, NextFunction } from 'express';
import { handleResponseJob } from '../../workers/responses/handler';
import { S3_PREFIX } from '../../config/s3Prefixes';

const router = Router();

// POST /admin/responses/:institutionId/:courseId/:batchId
// Manually triggers response processing for the monolith / single-Lambda env where
// no S3 → SQS → Lambda chain exists. Reads response.json from the responses bucket
// at the conventional path and runs the same handler the dev-env worker uses.
router.post(
  '/responses/:institutionId/:courseId/:batchId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId, batchId } = req.params;
      const key = `${institutionId}/${courseId}/${batchId}.json`;
      await handleResponseJob({ prefix: S3_PREFIX.RESPONSES, key });
      res.json({ success: true, processed: { prefix: S3_PREFIX.RESPONSES, key } });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
