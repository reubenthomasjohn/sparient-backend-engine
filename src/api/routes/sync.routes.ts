import { Router, Request, Response, NextFunction } from 'express';
import { SyncOrchestrator } from '../../services/sync/SyncOrchestrator';
import prisma from '../../db/client';
import { logger } from '../../utils/logger';

const router = Router();
const syncOrchestrator = new SyncOrchestrator();

// POST /sync/institutions/:institutionId?force=true
// Triggers a full sync for all courses in an institution.
// ?force=true clears lastSyncedAt on all courses, forcing a full re-sync.
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
        // Reset canvasModifiedAt to epoch so FileChangeDetector treats every file
        // as changed and re-queues it, regardless of current status.
        await prisma.sourceFile.updateMany({
          where: { course: { institutionId } },
          data: { canvasModifiedAt: new Date(0) },
        });
        logger.info('Sync: forced full re-sync', { institutionId });
      }

      res.json({ success: true, message: force ? 'Full re-sync started' : 'Sync started', institutionId });

      syncOrchestrator.syncInstitution(institutionId).catch((err) =>
        logger.error('Sync failed', { institutionId, error: err }),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /sync/institutions/:institutionId/courses/:courseId?force=true
// Triggers a sync for a single course.
// ?force=true clears lastSyncedAt on that course, forcing a full re-sync.
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
          data: { canvasModifiedAt: new Date(0) },
        });
        logger.info('Sync: forced full re-sync', { institutionId, courseId });
      }

      res.json({ success: true, message: force ? 'Full re-sync started' : 'Course sync started', institutionId, courseId });

      syncOrchestrator.syncInstitution(institutionId, courseId).catch((err) =>
        logger.error('Course sync failed', { institutionId, courseId, error: err }),
      );
    } catch (err) {
      next(err);
    }
  },
);

export default router;
