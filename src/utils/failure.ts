import { LastOutcome, SourceFile } from '@prisma/client';
import { config } from '../config';

export interface FailureUpdate {
  lastOutcome: LastOutcome;
  lastFailureReason: string;
  retryCount: number;
  nextRetryAt: Date | null;
}

// Exponential backoff: base * 4^retryCount. With defaults: 30m, 2h, 8h.
export function computeFailureUpdate(
  current: Pick<SourceFile, 'retryCount' | 'maxRetries'>,
  reason: string,
): FailureUpdate {
  const newCount = current.retryCount + 1;
  const isPermanent = newCount >= current.maxRetries;

  return {
    lastOutcome: isPermanent ? 'permanently_failed' : 'failed',
    lastFailureReason: reason,
    retryCount: newCount,
    nextRetryAt: isPermanent
      ? null
      : new Date(
          Date.now() +
            config.jobs.retryBaseDelayMinutes * 60 * 1000 * Math.pow(4, current.retryCount),
        ),
  };
}
