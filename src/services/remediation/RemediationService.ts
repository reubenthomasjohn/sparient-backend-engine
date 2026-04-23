import { BatchStatus, ConnectivoFileState, QualityLabel } from '@prisma/client';
import prisma from '../../db/client';
import { ConnectivoResultsPayload, ConnectivoFileResult } from '../../types/connectivo';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/errors';
import { computeFailureUpdate } from '../../utils/failure';

const STATE_MAP: Record<string, ConnectivoFileState> = {
  Completed: 'completed',
  CompletedWithWarnings: 'completed_with_warnings',
  Failed: 'failed',
};

const QUALITY_MAP: Record<string, QualityLabel> = {
  Excellent: 'Excellent',
  Good: 'Good',
  RequiresReview: 'RequiresReview',
  Failed: 'Failed',
  Unchanged: 'Unchanged',
};

const TERMINAL_BATCH_STATUSES: BatchStatus[] = ['completed', 'completed_with_warnings', 'failed'];

export class RemediationService {
  async handleResults(batchId: string, payload: ConnectivoResultsPayload): Promise<void> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { batchFiles: { include: { sourceFile: true } } },
    });

    if (!batch) throw Errors.notFound('Batch');

    if (TERMINAL_BATCH_STATUSES.includes(batch.status)) {
      logger.info('RemediationService: batch already terminal, ignoring re-delivery', { batchId });
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
  }
}
