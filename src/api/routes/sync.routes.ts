import { Router, Request, Response, NextFunction } from 'express';
import { SyncOrchestrator } from '../../services/sync/SyncOrchestrator';
import prisma from '../../db/client';
import { logger } from '../../utils/logger';

const router = Router();
const syncOrchestrator = new SyncOrchestrator();

// POST /sync/institutions/:institutionId?force=true
// ?force=true clears lastSyncedAt and rewinds discovered_modified_at so the next
// discovery treats every file as changed.
router.post(
  '/institutions/:institutionId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;
      const force = req.query.force === 'true';

      if (force) {
        await prisma.course.updateMany({
          where: { institutionId },
          data: { lastSyncedAt: null },
        });
        await prisma.sourceFile.updateMany({
          where: { course: { institutionId } },
          data: { discoveredModifiedAt: new Date(0) },
        });
        logger.info('Sync: forced full re-sync', { institutionId });
      }

      await syncOrchestrator.syncInstitution(institutionId, undefined, force);
      res.json({ success: true, message: force ? 'Full re-sync enqueued' : 'Sync enqueued', institutionId });
    } catch (err) {
      next(err);
    }
  },
);

// POST /sync/institutions/:institutionId/courses/:courseId?force=true
router.post(
  '/institutions/:institutionId/courses/:courseId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId } = req.params;
      const force = req.query.force === 'true';

      if (force) {
        const courses = await prisma.course.findMany({
          where: { institutionId, canvasCourseId: courseId },
          select: { id: true },
        });
        const courseIds = courses.map((c) => c.id);

        await prisma.course.updateMany({
          where: { id: { in: courseIds } },
          data: { lastSyncedAt: null },
        });
        await prisma.sourceFile.updateMany({
          where: { courseId: { in: courseIds } },
          data: { discoveredModifiedAt: new Date(0) },
        });
        logger.info('Sync: forced full re-sync', { institutionId, courseId });
      }

      await syncOrchestrator.syncInstitution(institutionId, courseId, force);
      res.json({
        success: true,
        message: force ? 'Full re-sync enqueued' : 'Course sync enqueued',
        institutionId,
        courseId,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
