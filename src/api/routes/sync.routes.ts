import { Router, Request, Response, NextFunction } from 'express';
import { LastOutcome } from '@prisma/client';
import { SyncOrchestrator } from '../../services/sync/SyncOrchestrator';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();
const syncOrchestrator = new SyncOrchestrator();

// POST /sync/institutions/:institutionId?force=true
// Enqueues a discover message. The discovery Lambda lists courses and starts one
// Step Functions execution per course.
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

      await syncOrchestrator.syncInstitution(institutionId, force);
      res.json({ success: true, message: force ? 'Full re-sync enqueued' : 'Sync enqueued', institutionId });
    } catch (err) {
      next(err);
    }
  },
);

// POST /sync/institutions/:institutionId/courses/:courseId?force=true
// Starts a Step Functions execution for a single course directly.
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
        logger.info('Sync: forced course re-sync', { institutionId, courseId });
      }

      await syncOrchestrator.syncCourse(institutionId, courseId, force);
      res.json({
        success: true,
        message: force ? 'Full re-sync started' : 'Course sync started',
        institutionId,
        courseId,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /sync/institutions/:institutionId/courses/:courseId/retry-failed?include_permanently_failed=true
// Resets failed source_files in the course and starts a force sync so request.json
// carries force_reprocess: true. By default only last_outcome='failed' rows are reset;
// pass include_permanently_failed=true to also reset permanently_failed rows.
router.post(
  '/institutions/:institutionId/courses/:courseId/retry-failed',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId } = req.params;
      const includePermanentlyFailed = req.query.include_permanently_failed === 'true';

      const course = await prisma.course.findFirst({
        where: { institutionId, canvasCourseId: courseId },
        select: { id: true },
      });
      if (!course) throw Errors.notFound('Course');

      const outcomes: LastOutcome[] = includePermanentlyFailed
        ? [LastOutcome.failed, LastOutcome.permanently_failed]
        : [LastOutcome.failed];

      const { count } = await prisma.sourceFile.updateMany({
        where: { courseId: course.id, lastOutcome: { in: outcomes } },
        data: {
          lastOutcome: null,
          lastFailureReason: null,
          retryCount: 0,
          nextRetryAt: null,
          batchedModifiedAt: null,
        },
      });

      if (count === 0) {
        res.json({
          success: true,
          resetCount: 0,
          message: 'No failed files to retry',
          institutionId,
          courseId,
        });
        return;
      }

      logger.info('Sync: retry-failed triggered', {
        institutionId,
        courseId,
        resetCount: count,
        includePermanentlyFailed,
      });

      await syncOrchestrator.syncCourse(institutionId, courseId, true);

      res.json({
        success: true,
        resetCount: count,
        message: 'Retry of failed files started',
        institutionId,
        courseId,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
