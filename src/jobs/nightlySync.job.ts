import cron from 'node-cron';
import prisma from '../db/client';
import { SyncOrchestrator } from '../services/sync/SyncOrchestrator';
import { logger } from '../utils/logger';
import { config } from '../config';

const orchestrator = new SyncOrchestrator();

export function startNightlySyncJob(): void {
  const schedule = config.jobs.syncCronSchedule;

  if (!cron.validate(schedule)) {
    logger.error('Invalid sync cron schedule, job not started', { schedule });
    return;
  }

  cron.schedule(schedule, async () => {
    logger.info('Nightly sync job: starting');

    const institutions = await prisma.institution.findMany({
      where: { syncEnabled: true },
    });

    logger.info('Nightly sync job: institutions to sync', { count: institutions.length });

    for (const institution of institutions) {
      try {
        await orchestrator.syncInstitution(institution.id);
      } catch (err) {
        logger.error('Nightly sync job: institution sync failed', {
          institutionId: institution.id,
          error: err,
        });
      }
    }

    logger.info('Nightly sync job: complete');
  });

  logger.info('Nightly sync job scheduled', { schedule });
}
