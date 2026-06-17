import axios from 'axios';
import { WritebackJob } from '../../queue';
import prisma from '../../db/client';
import { writebackService } from '../../services/writeback/WritebackService';
import { logger } from '../../utils/logger';

// Status codes that are 4xx but still worth retrying (server-side/transient by spec).
const RETRYABLE_4XX = new Set([408, 425, 429]); // Request Timeout, Too Early, Too Many Requests

// Permanent errors won't succeed on retry, so we don't redrive them (they'd just churn to
// the DLQ). 4xx except the retryable set are permanent; everything else (5xx / network /
// unclassifiable app errors) is treated as transient — safer to retry.
export function isPermanentWritebackError(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    return typeof status === 'number' && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);
  }
  return false;
}

// Thin wrapper over WritebackService (the unit-tested seam): stamp errors 'failed', re-throw
// only transient ones so SQS redrives; permanent errors are swallowed (already stamped).
export async function handleWritebackJob(job: WritebackJob): Promise<void> {
  try {
    await writebackService.writeBack(job.batchFileId, {
      ignoreOptIn: job.ignoreOptIn,
      sourceFileId: job.sourceFileId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('Writeback: job failed', { batchFileId: job.batchFileId, error: reason });

    // Best-effort failure recording in its own try/catch (a DB blip here still lets SQS
    // redrive). Guarded so we never overwrite a 'written'/'skipped_stale' the service may
    // have stamped before a later statement threw — that would be a false negative.
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
