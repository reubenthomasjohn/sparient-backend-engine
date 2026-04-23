import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../db/client';
import { handleResponseJob } from '../../workers/responses/handler';
import { getBucketName } from '../../config/s3Bucket';
import { Errors } from '../../utils/errors';

const router = Router();

// POST /admin/responses/:institutionId/:courseId/:batchId
router.post(
  '/responses/:institutionId/:courseId/:batchId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId, batchId } = req.params;
      const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
      if (!institution) throw Errors.notFound('Institution');

      const bucket = getBucketName(institutionId, institution.s3Bucket);
      const key = `${institutionId}/${courseId}/${batchId}.json`;
      await handleResponseJob({ bucket, key });
      res.json({ success: true, processed: { bucket, key } });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
