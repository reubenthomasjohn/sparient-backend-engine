import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// DELETE /institutions/:institutionId/data
// Wipes all course/file/batch data for an institution, leaving the institution row intact.
// Useful for resetting a dev/test environment or forcing a clean re-sync.
router.delete(
  '/:institutionId/data',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;

      const institution = await prisma.institution.findUnique({
        where: { id: institutionId },
      });

      if (!institution) throw Errors.notFound('Institution');

      const result = await prisma.$transaction(async (tx) => {
        // Delete in FK-safe order: leaf tables first, then parents
        const { count: issueCategories } = await tx.fileIssueCategory.deleteMany({
          where: { batchFile: { batch: { institutionId } } },
        });

        const { count: batchFiles } = await tx.batchFile.deleteMany({
          where: { batch: { institutionId } },
        });

        const { count: batches } = await tx.batch.deleteMany({
          where: { institutionId },
        });

        const { count: sourceFiles } = await tx.sourceFile.deleteMany({
          where: { course: { institutionId } },
        });

        const { count: courses } = await tx.course.deleteMany({
          where: { institutionId },
        });

        return { issueCategories, batchFiles, batches, sourceFiles, courses };
      });

      logger.info('Institution data wiped', { institutionId, ...result });

      res.json({ success: true, institutionId, deleted: result });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
