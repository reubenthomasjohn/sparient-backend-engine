import cron from 'node-cron';
import { discoveryQueue } from '../queue';
import { logger } from '../utils/logger';
import { config } from '../config';

// Local-dev only. In prod EventBridge puts the same `sweep` message on SQS directly.
// The sweep handler (src/workers/discovery/handler.ts) decides which institutions are
// due and also re-queues retry-eligible files.
export function startNightlySyncJob(): void {
  const schedule = config.jobs.syncCronSchedule;

  if (!cron.validate(schedule)) {
    logger.error('Invalid sync cron schedule, job not started', { schedule });
    return;
  }

  cron.schedule(schedule, async () => {
    logger.info('Nightly sweep: enqueueing');
    try {
      await discoveryQueue.send({ type: 'sweep' });
    } catch (err) {
      logger.error('Nightly sweep: enqueue failed', { error: err });
    }
  });

  logger.info('Nightly sweep scheduled', { schedule });
}
