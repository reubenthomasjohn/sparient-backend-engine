import { Router, Request, Response, NextFunction } from 'express';
import { handleResponseJob } from '../../workers/responses/handler';
import { config } from '../../config';

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
      await handleResponseJob({ bucket: config.aws.s3ResponsesBucket, key });
      res.json({ success: true, processed: { bucket: config.aws.s3ResponsesBucket, key } });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
