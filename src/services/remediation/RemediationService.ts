import { BatchStatus, ConnectivoFileState, QualityLabel } from '@prisma/client';
import prisma from '../../db/client';
import { ConnectivoResultsPayload } from '../../types/connectivo';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/errors';
import { computeFailureUpdate } from '../../utils/failure';

const STATE_MAP: Record<string, ConnectivoFileState> = {
  Completed: 'completed',
  CompletedWithWarnings: 'completed_with_warnings',
  Failed: 'failed',
};

const QUALITY_MAP: Record<string, QualityLabel> = {
  A: 'A',
  AA: 'AA',
  AAA: 'AAA',
};

const TERMINAL_BATCH_STATUSES: BatchStatus[] = ['completed', 'completed_with_warnings', 'failed'];

export class RemediationService {
  // Called by the responses Lambda after fetching response.json from S3. The S3 path
  // (which contains our batchId) is the matching key — institution scoping is implicit.
  async handleResults(batchId: string, payload: ConnectivoResultsPayload): Promise<void> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { batchFiles: { include: { sourceFile: true } } },
    });

    if (!batch) throw Errors.notFound('Batch');

    // Idempotent re-delivery (S3 events can fire twice; Connectivo can re-write).
    // A second response for an already-terminal batch is a no-op.
    if (TERMINAL_BATCH_STATUSES.includes(batch.status)) {
      logger.info('RemediationService: batch already terminal, ignoring re-delivery', { batchId });
      return;
    }

    logger.info('RemediationService: processing results', {
      batchId,
      connectivoBatchId: payload.batch.id,
    });

    const fileResultMap = new Map(
      payload.folders.flatMap((folder) => folder.files.map((f) => [f.file_id, f])),
    );

    await prisma.$transaction(async (tx) => {
      for (const batchFile of batch.batchFiles) {
        const result = fileResultMap.get(batchFile.sourceFileId);

        // Missing from response — mark failed rather than leave stuck in-flight.
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
        const qualityLabel = result.quality_label ? QUALITY_MAP[result.quality_label] : null;
        const remediatedS3Key = result.remediated_path ?? null;

        await tx.batchFile.update({
          where: { id: batchFile.id },
          data: {
            connectivoState,
            qualityLabel,
            remediatedS3Key,
            remediatedS3Bucket: remediatedS3Key ? batch.requestS3Bucket : null,
            totalPages: result.total_pages,
            processingTimeSecs: result.processing_time_seconds,
            verapdfErrors: result.verapdf_errors,
            verapdfWarnings: result.verapdf_warnings,
            errorMessage: result.error,
          },
        });

        if (Object.keys(result.issues_by_category).length > 0) {
          await tx.fileIssueCategory.createMany({
            data: Object.entries(result.issues_by_category).map(([category, counts]) => ({
              batchFileId: batchFile.id,
              category,
              found: counts.found,
              fixed: counts.fixed,
              remaining: counts.remaining,
            })),
          });
        }

        // Guard: only write the outcome if the file hasn't been claimed by a newer batch.
        // If batchedModifiedAt has advanced past this batch's version, a newer cycle owns the
        // file — skip the source_file update so we don't overwrite in-flight state.
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

      // Clamp completed_at to now — Connectivo clock skew would otherwise produce
      // future-dated timestamps that break "completed in the last hour" queries.
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
  }
}
