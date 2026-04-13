import { Router, Request, Response, NextFunction } from 'express';
import { BatchStatus } from '@prisma/client';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';

const router = Router();

// GET /batches/:batchId
router.get('/:batchId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = await prisma.batch.findUnique({
      where: { id: req.params.batchId },
      include: { institution: true, course: true },
    });

    if (!batch) throw Errors.notFound('Batch');

    res.json({ success: true, data: batch });
  } catch (err) {
    next(err);
  }
});

// GET /batches/:batchId/files
router.get('/:batchId/files', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batchFiles = await prisma.batchFile.findMany({
      where: { batchId: req.params.batchId },
      include: { sourceFile: true, issueCategories: true },
    });

    res.json({ success: true, data: batchFiles });
  } catch (err) {
    next(err);
  }
});

// GET /institutions/:institutionId/batches
router.get(
  '/institutions/:institutionId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;
      const { status, courseId } = req.query;

      const batches = await prisma.batch.findMany({
        where: {
          institutionId,
          ...(status ? { status: status as BatchStatus } : {}),
          ...(courseId ? { courseId: courseId as string } : {}),
        },
        include: { course: true },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: batches });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
