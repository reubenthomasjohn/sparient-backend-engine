import cron from 'node-cron';
import { RetryService } from '../services/retry/RetryService';
import { logger } from '../utils/logger';
import { config } from '../config';

const retryService = new RetryService();

export function startRetryJob(): void {
  const schedule = config.jobs.retryCronSchedule;

  if (!cron.validate(schedule)) {
    logger.error('Invalid retry cron schedule, job not started', { schedule });
    return;
  }

  cron.schedule(schedule, async () => {
    logger.info('Retry job: starting pass');
    try {
      await retryService.runRetryPass();
    } catch (err) {
      logger.error('Retry job: pass failed', { error: err });
    }
    logger.info('Retry job: pass complete');
  });

  logger.info('Retry job scheduled', { schedule });
}
