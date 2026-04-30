import { BatchStatus, ConnectivoFileState, QualityLabel } from '@prisma/client';
import prisma from '../../db/client';
import { ConnectivoResultsPayload, ConnectivoFileResult } from '../../types/connectivo';
import { S3_PREFIX } from '../../config/s3Prefixes';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/errors';
import { computeFailureUpdate } from '../../utils/failure';
import { writebackQueue } from '../../queue';

const STATE_MAP: Record<string, ConnectivoFileState> = {
  Completed: 'completed',
  CompletedWithWarnings: 'completed_with_warnings',
  Failed: 'failed',
};

const QUALITY_MAP: Record<string, QualityLabel> = {
  Excellent: 'Excellent',
  Good: 'Good',
  RequiresReview: 'RequiresReview',
  'Requires Review': 'RequiresReview',
  Failed: 'Failed',
  Unchanged: 'Unchanged',
};

const TERMINAL_BATCH_STATUSES: BatchStatus[] = ['completed', 'completed_with_warnings', 'failed'];

// Connectivo reports remediated_path as "/<bucket>/<key>". Strip leading slashes
// and the bucket segment to get the actual S3 key. Robust against malformed inputs
// like "//<bucket>/..." which the previous single regex silently passed through,
// and against "/<bucket>/" (bucket without a key) which would otherwise return "".
// Exported for unit tests.
export function stripBucketFromPath(path: string): string | null {
  const trimmed = path.replace(/^\/+/, '');
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash === -1) {
    logger.warn('RemediationService: remediated_path lacks bucket prefix', { path });
    return null;
  }
  const key = trimmed.slice(firstSlash + 1);
  if (key === '') {
    logger.warn('RemediationService: remediated_path has bucket but no key', { path });
    return null;
  }
  return key;
}

export class RemediationService {
  async handleResults(batchId: string, payload: ConnectivoResultsPayload): Promise<void> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { batchFiles: { include: { sourceFile: true } } },
    });

    if (!batch) throw Errors.notFound('Batch');

    if (TERMINAL_BATCH_STATUSES.includes(batch.status)) {
      // Re-delivery (Connectivo wrote response.json again, or our prior invocation
      // crashed between tx commit and writeback enqueue). The DB outcome work is
      // already done — but writebacks may not be, so re-run the idempotent producer.
      logger.info('RemediationService: batch already terminal, re-checking writeback enqueue', { batchId });
      await this.enqueueWritebacks(batchId);
      return;
    }

    logger.info('RemediationService: processing results', {
      batchId,
      connectivoBatchId: payload.batch.id,
    });

    // Match response files to our batch_files via custom_fields.file_id (our sourceFileId).
    const fileResultMap = new Map<string, ConnectivoFileResult>();
    for (const folder of payload.folders) {
      for (const file of folder.files) {
        const fileId = file.custom_fields?.file_id;
        if (fileId) fileResultMap.set(fileId, file);
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const batchFile of batch.batchFiles) {
        const result = fileResultMap.get(batchFile.sourceFileId);

        if (!result) {
          const reason = 'Missing from Connectivo response';
          await tx.batchFile.update({
            where: { id: batchFile.id },
            data: { connectivoState: 'failed', errorMessage: reason },
          });
          const fu = computeFailureUpdate(batchFile.sourceFile, reason);
          await tx.sourceFile.update({ where: { id: batchFile.sourceFileId }, data: fu });
          continue;
        }

        const connectivoState = STATE_MAP[result.state] ?? 'failed';
        const qualityLabel = result.quality_label ? (QUALITY_MAP[result.quality_label] ?? null) : null;
        const remediatedS3Key = result.remediated_path
          ? stripBucketFromPath(result.remediated_path)
          : null;

        await tx.batchFile.update({
          where: { id: batchFile.id },
          data: {
            connectivoState,
            qualityLabel,
            remediatedS3Key,
            remediatedS3Bucket: remediatedS3Key ? batch.requestS3Bucket : null,
            totalPages: result.total_pages,
            processingTimeSecs: result.processing_time_seconds,
            complianceErrors: result.compliance_errors,
            complianceWarnings: result.compliance_warnings,
            totalIssuesFound: result.total_issues_found,
            totalIssuesFixed: result.total_issues_fixed,
            errorMessage: result.error ?? null,
          },
        });

        // Store issue categories + individual issue details (as JSON).
        if (result.issues_by_category.length > 0) {
          await tx.fileIssueCategory.createMany({
            data: result.issues_by_category.map((cat) => ({
              batchFileId: batchFile.id,
              category: cat.issue_category,
              found: cat.found,
              fixed: cat.fixed,
              remaining: cat.remaining,
              issues: cat.issues ?? [],
            })),
          });
        }

        // Guard: only write the outcome if the file hasn't been claimed by a newer batch.
        if (connectivoState === 'completed') {
          await tx.sourceFile.updateMany({
            where: { id: batchFile.sourceFileId, batchedModifiedAt: batchFile.sourceModifiedAt },
            data: { lastOutcome: 'completed', lastFailureReason: null },
          });
        } else if (connectivoState === 'completed_with_warnings') {
          await tx.sourceFile.updateMany({
            where: { id: batchFile.sourceFileId, batchedModifiedAt: batchFile.sourceModifiedAt },
            data: { lastOutcome: 'completed_with_warnings', lastFailureReason: null },
          });
        } else {
          const fu = computeFailureUpdate(
            batchFile.sourceFile,
            result.error ?? 'Connectivo reported failure',
          );
          await tx.sourceFile.updateMany({
            where: { id: batchFile.sourceFileId, batchedModifiedAt: batchFile.sourceModifiedAt },
            data: fu,
          });
        }
      }

      const summary = payload.batch.summary;
      const batchStatus: BatchStatus =
        summary.failed > 0 && summary.succeeded === 0
          ? 'failed'
          : summary.failed > 0 || summary.requires_review > 0
            ? 'completed_with_warnings'
            : 'completed';

      const connectivoCompletedAt = new Date(payload.batch.completed_at).getTime();
      const completedAt = new Date(Math.min(Date.now(), connectivoCompletedAt));

      await tx.batch.update({
        where: { id: batchId },
        data: {
          status: batchStatus,
          connectivoBatchId: payload.batch.id,
          completedAt,
          totalPages: summary.total_pages,
          succeeded: summary.succeeded,
          failed: summary.failed,
          requiresReview: summary.requires_review,
          totalIssuesFound: summary.total_issues_found,
          totalIssuesFixed: summary.total_issues_fixed,
        },
      });
    });

    logger.info('RemediationService: results processed', { batchId });

    // After the transaction commits, fan out writeback jobs for eligible files.
    // Eligibility is re-checked inside the worker — the producer query just avoids
    // enqueueing jobs that are obviously not actionable (no remediated bytes,
    // failed state, opt-out at the institution level).
    await this.enqueueWritebacks(batchId);
  }

  // Idempotent: safe to call multiple times for the same batch. SQS redrives and
  // crash-recovery from a re-delivered response use this path to catch up — already
  // -written files are skipped, already-superseded ones are skipped, and per-send
  // failures don't abandon the rest of the batch.
  private async enqueueWritebacks(batchId: string): Promise<void> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: {
        institution: { select: { writebackOptIn: true } },
        course: { select: { writebackOptIn: true } },
        batchFiles: {
          select: {
            id: true,
            connectivoState: true,
            remediatedS3Key: true,
            remediatedS3Bucket: true,
            sourceModifiedAt: true,
            sourceFile: {
              select: {
                writebackState: true,
                lastWritebackModifiedAt: true,
                batchedModifiedAt: true,
              },
            },
          },
        },
      },
    });

    if (!batch) return;

    const optedIn = batch.course.writebackOptIn ?? batch.institution.writebackOptIn;
    if (!optedIn) {
      logger.info('RemediationService: writeback skipped — opt-out', { batchId });
      return;
    }

    const eligible = batch.batchFiles.filter((bf) => {
      if (bf.connectivoState !== 'completed' && bf.connectivoState !== 'completed_with_warnings') {
        return false;
      }
      if (!bf.remediatedS3Key || !bf.remediatedS3Bucket) return false;

      const sf = bf.sourceFile;

      // Supersession: a newer batch already claimed this source_file. The consumer
      // would skip it; mirror the check here so we don't spam SQS on redelivery.
      if (
        sf.batchedModifiedAt === null ||
        sf.batchedModifiedAt.getTime() !== bf.sourceModifiedAt.getTime()
      ) {
        return false;
      }

      // Dedupe: a successful writeback stamps lastWritebackModifiedAt with Canvas's
      // post-upload timestamp, which is strictly *after* our sourceModifiedAt. So
      // "already written for this version" = state is 'written' AND the stamped
      // Canvas time sits past our sourceModifiedAt.
      const alreadyWrittenForVersion =
        sf.writebackState === 'written' &&
        sf.lastWritebackModifiedAt !== null &&
        sf.lastWritebackModifiedAt.getTime() > bf.sourceModifiedAt.getTime();
      return !alreadyWrittenForVersion;
    });

    if (eligible.length === 0) return;

    let sent = 0;
    let failed = 0;
    for (const bf of eligible) {
      try {
        await writebackQueue.send({ batchFileId: bf.id });
        sent++;
      } catch (err) {
        failed++;
        logger.error('RemediationService: writeback enqueue failed, continuing', {
          batchId,
          batchFileId: bf.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('RemediationService: writeback jobs enqueued', { batchId, sent, failed });

    // Throw if anything failed so SQS redrives the response message — the dedupe +
    // supersession filters above make redelivery idempotent (already-sent jobs are
    // skipped). Returning success on a partial failure would silently lose work.
    if (failed > 0) {
      throw new Error(
        `Writeback enqueue partially failed for batch ${batchId}: sent=${sent} failed=${failed}`,
      );
    }
  }
}
