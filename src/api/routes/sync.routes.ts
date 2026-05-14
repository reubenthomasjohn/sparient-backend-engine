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

// POST /sync/institutions/:institutionId/courses/:courseId/retry-failed?includePermanentlyFailed=true
// Resets failed source_files in the course and starts a force sync so request.json
// carries force_reprocess: true. By default only last_outcome='failed' rows are reset;
// pass includePermanentlyFailed=true to also reset permanently_failed rows.
router.post(
  '/institutions/:institutionId/courses/:courseId/retry-failed',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId } = req.params;
      const includePermanentlyFailed = String(req.query.includePermanentlyFailed) === 'true';

      const institution = await prisma.institution.findUnique({
        where: { id: institutionId },
        select: { id: true },
      });
      if (!institution) throw Errors.notFound('Institution');

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
          discoveredModifiedAt: new Date(0),
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

// POST /sync/institutions/:institutionId/courses/:courseId/reprocess-all
// Clears state on every source_file in the course (except deleted rows and rows
// currently in a pending batch) and starts a force sync. Unlike ?force=true on
// the course route — which only re-batches files whose Canvas content advanced —
// this clears batched_modified_at so BatchBuilder claims every row whether or
// not S3 content changed.
//
// Excluded from the reset:
//   - last_outcome='deleted' rows: Canvas has no writeback target, so sending
//     their stale S3 bytes to Connectivo would burn billing and fail writeback.
//   - Rows currently referenced by a pending batch_files row: clearing
//     batched_modified_at on those would race with BatchBuilder's atomic claim
//     and let the next sync re-claim them into a second pending batch — Connectivo
//     would process the same file twice and the two writebacks would race.
router.post(
  '/institutions/:institutionId/courses/:courseId/reprocess-all',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId } = req.params;

      const course = await prisma.course.findFirst({
        where: { institutionId, canvasCourseId: courseId },
        select: { id: true },
      });
      if (!course) throw Errors.notFound('Course');

      // Count rows we're about to skip so the response can tell the caller
      // why resetCount may be lower than the course's total file count.
      const skippedInFlight = await prisma.sourceFile.count({
        where: {
          courseId: course.id,
          batchFiles: { some: { batch: { status: 'pending' } } },
        },
      });

      const { count } = await prisma.sourceFile.updateMany({
        where: {
          courseId: course.id,
          OR: [
            { lastOutcome: null },
            { lastOutcome: { notIn: [LastOutcome.deleted] } },
          ],
          batchFiles: { none: { batch: { status: 'pending' } } },
        },
        data: {
          lastOutcome: null,
          lastFailureReason: null,
          retryCount: 0,
          nextRetryAt: null,
          batchedModifiedAt: null,
          // Reset to epoch so FileChangeDetector flags every row as
          // "newer than its last-seen Canvas modified_at." Without this,
          // files that never uploaded successfully (s3_source_key IS NULL)
          // are silently stranded — BatchBuilder requires s3_source_key
          // and FileChangeDetector wouldn't re-queue an upload because
          // isNewer would evaluate false.
          discoveredModifiedAt: new Date(0),
        },
      });

      if (count === 0) {
        res.json({
          success: true,
          resetCount: 0,
          skippedInFlight,
          message:
            skippedInFlight > 0
              ? 'All eligible files are currently in a pending batch; nothing to reset. Wait for the in-flight batch to complete, then retry.'
              : 'No files in course to reprocess',
          institutionId,
          courseId,
        });
        return;
      }

      logger.info('Sync: reprocess-all triggered', {
        institutionId,
        courseId,
        resetCount: count,
        skippedInFlight,
      });

      await syncOrchestrator.syncCourse(institutionId, courseId, true);

      res.json({
        success: true,
        resetCount: count,
        skippedInFlight,
        message: 'Reprocess of all course files started',
        institutionId,
        courseId,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /sync/institutions/:institutionId/courses/:canvasCourseId/files/:canvasFileId?force=true
// User-driven "remediate this one file now". Runs inline (refresh from Canvas →
// upload → batch) and returns the resulting batchId synchronously. UI polls
// GET /batches/:batchId for completion. Defaults force=true — if the user clicked
// "remediate", they expect a fresh batch even if Canvas content is unchanged.
router.post(
  '/institutions/:institutionId/courses/:canvasCourseId/files/:canvasFileId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, canvasCourseId, canvasFileId } = req.params;
      // Coerce to string before equality. Express parses repeated query keys
      // (?force=a&force=b) as arrays, which would silently fall through the
      // `=== 'true'` check and become false — turning a forced trigger into
      // a non-forced one without any error.
      const rawForce = Array.isArray(req.query.force) ? req.query.force[0] : req.query.force;
      const force = rawForce === undefined ? true : rawForce === 'true';

      const result = await syncOrchestrator.syncFile(
        institutionId,
        canvasCourseId,
        canvasFileId,
        force,
      );

      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
