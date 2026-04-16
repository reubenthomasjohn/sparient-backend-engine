import prisma from '../../db/client';
import { discoveryQueue } from '../../queue';
import { logger } from '../../utils/logger';

// Thin entry point for the nightly cron and /sync API routes. Does not do work inline —
// the actual discovery happens in the discovery worker (in-process poller in dev,
// Lambda in prod). Keeps the API responsive and the cron cheap.
export class SyncOrchestrator {
  async syncInstitution(institutionId: string, courseId?: string, force?: boolean): Promise<void> {
    await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    await discoveryQueue.send({ type: 'discover', institutionId, courseId, force });
    logger.info('SyncOrchestrator: discovery job enqueued', { institutionId, courseId, force });
  }
}
