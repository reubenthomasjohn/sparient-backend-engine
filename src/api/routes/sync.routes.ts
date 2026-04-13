import { Router, Request, Response, NextFunction } from 'express';
import { SyncOrchestrator } from '../../services/sync/SyncOrchestrator';
import { logger } from '../../utils/logger';

const router = Router();
const syncOrchestrator = new SyncOrchestrator();

// POST /sync/institutions/:institutionId
// Triggers a full sync for all courses in an institution
router.post(
  '/institutions/:institutionId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;

      // Respond immediately — sync runs in the background
      res.json({ success: true, message: 'Sync started', institutionId });

      syncOrchestrator.syncInstitution(institutionId).catch((err) =>
        logger.error('Sync failed', { institutionId, error: err }),
      );
    } catch (err) {
      next(err);
    }
  },
);

// POST /sync/institutions/:institutionId/courses/:courseId
// Triggers a sync for a single course
router.post(
  '/institutions/:institutionId/courses/:courseId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId, courseId } = req.params;

      res.json({ success: true, message: 'Course sync started', institutionId, courseId });

      syncOrchestrator.syncInstitution(institutionId, courseId).catch((err) =>
        logger.error('Course sync failed', { institutionId, courseId, error: err }),
      );
    } catch (err) {
      next(err);
    }
  },
);

export default router;
