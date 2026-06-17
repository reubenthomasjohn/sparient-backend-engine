import axios from 'axios';
import { WritebackJob } from '../../queue';
import prisma from '../../db/client';
import { writebackService } from '../../services/writeback/WritebackService';
import { logger } from '../../utils/logger';

// Permanent errors won't succeed on retry, so we DON'T redrive them — they'd only churn
// through maxReceiveCount to the DLQ. Canvas client errors (4xx except 429) are permanent.
// 429 / 5xx / network / timeout and anything unclassifiable are transient (safe to retry).
export function isPermanentWritebackError(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
  }
  return false;
}

// Thin wrapper: WritebackService is the unit-tested seam. The handler translates transport
// errors into a `failed` writebackState, then re-throws ONLY transient errors so SQS redrives;
// permanent errors are swallowed (already stamped failed) so they don't churn to the DLQ.
export async function handleWritebackJob(job: WritebackJob): Promise<void> {
  try {
    await writebackService.writeBack(job.batchFileId, {
      ignoreOptIn: job.ignoreOptIn,
      sourceFileId: job.sourceFileId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('Writeback: job failed', { batchFileId: job.batchFileId, error: reason });

    // Best-effort failure recording. A separate try/catch — if this update itself
    // fails (e.g. DB blip), we still want SQS to redrive.
    //
    // Use updateMany with a guard so we don't overwrite a successful terminal state.
    // The service may have already stamped 'written' or 'skipped_stale' before a
    // *later* statement threw — in that case the success record is the truth, and
    // marking it 'failed' would be a false negative. Only stamp 'failed' if the
    // current state is null or a previous 'failed'.
    try {
      const batchFile = await prisma.batchFile.findUnique({
        where: { id: job.batchFileId },
        select: { sourceFileId: true },
      });
      if (batchFile) {
        await prisma.sourceFile.updateMany({
          where: {
            id: batchFile.sourceFileId,
            OR: [
              { writebackState: null },
              { writebackState: 'failed' },
              { writebackState: 'queued' },
              { writebackState: 'in_progress' },
            ],
          },
          data: { writebackState: 'failed' },
        });
      }
    } catch (innerErr) {
      logger.error('Writeback: failed to record failure state', {
        batchFileId: job.batchFileId,
        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }

    // Permanent failures are already recorded; don't redrive them to the DLQ.
    if (isPermanentWritebackError(err)) {
      logger.warn('Writeback: permanent failure, not redriving', {
        batchFileId: job.batchFileId,
        error: reason,
      });
      return;
    }

    throw err;
  }
}
