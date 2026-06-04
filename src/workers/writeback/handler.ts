import { WritebackJob } from '../../queue';
import prisma from '../../db/client';
import { writebackService } from '../../services/writeback/WritebackService';
import { logger } from '../../utils/logger';

// Thin wrapper: WritebackService is the unit-tested seam. The handler exists to
// translate transport errors into a `failed` writebackState before re-throwing
// so SQS can redrive — DLQ catches terminal failures.
export async function handleWritebackJob(job: WritebackJob): Promise<void> {
  try {
    await writebackService.writeBack(job.batchFileId, { ignoreOptIn: job.ignoreOptIn });
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

    throw err;
  }
}
