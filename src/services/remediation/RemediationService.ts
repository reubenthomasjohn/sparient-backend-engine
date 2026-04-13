import { ConnectivoFileState, Institution, Course, QualityLabel } from '@prisma/client';
import prisma from '../../db/client';
import { ConnectivoResultsPayload } from '../../types/connectivo';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/errors';
import { BatchBuilder } from '../sync/BatchBuilder';
import { config } from '../../config';

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

export class RemediationService {
  private readonly batchBuilder = new BatchBuilder();

  async handleResults(batchId: string, payload: ConnectivoResultsPayload): Promise<void> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { batchFiles: { include: { sourceFile: true } }, course: true, institution: true },
    });

    if (!batch) throw Errors.notFound('Batch');

    if (batch.status !== 'processing') {
      throw Errors.conflict(`Batch is in status '${batch.status}', cannot accept results`);
    }

    logger.info('RemediationService: processing results', {
      batchId,
      connectivoBatchId: payload.batch.id,
    });

    // Flatten all file results from all folders for easy lookup by file_id
    const fileResultMap = new Map(
      payload.folders.flatMap((folder) => folder.files.map((f) => [f.file_id, f])),
    );

    const summary = payload.batch.summary;

    await prisma.$transaction(async (tx) => {
      for (const batchFile of batch.batchFiles) {
        const result = fileResultMap.get(batchFile.sourceFileId);
        if (!result) continue;

        const connectivoState = STATE_MAP[result.state] ?? 'failed';
        const qualityLabel = result.quality_label ? QUALITY_MAP[result.quality_label] : null;

        // Derive remediated S3 key from the path Connectivo returns
        const remediatedS3Key = result.remediated_path ?? null;

        await tx.batchFile.update({
          where: { id: batchFile.id },
          data: {
            connectivoState,
            qualityLabel,
            remediatedS3Key,
            remediatedS3Bucket: remediatedS3Key ? config.aws.s3RemediatedBucket : null,
            totalPages: result.total_pages,
            processingTimeSecs: result.processing_time_seconds,
            verapdfErrors: result.verapdf_errors,
            verapdfWarnings: result.verapdf_warnings,
            errorMessage: result.error,
          },
        });

        // Store per-category issue breakdown
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

        // Resolve the source file's final status
        let nextFileStatus: 'completed' | 'completed_with_warnings' | 'failed';
        if (connectivoState === 'completed') nextFileStatus = 'completed';
        else if (connectivoState === 'completed_with_warnings') nextFileStatus = 'completed_with_warnings';
        else {
          nextFileStatus = 'failed';
        }

        const updateData: Parameters<typeof tx.sourceFile.update>[0]['data'] = {
          status: nextFileStatus,
          pendingResubmit: false,
        };

        if (nextFileStatus === 'failed') {
          const newRetryCount = batchFile.sourceFile.retryCount + 1;
          const isPermanent = newRetryCount >= batchFile.sourceFile.maxRetries;

          updateData.status = isPermanent ? 'permanently_failed' : 'failed';
          updateData.retryCount = newRetryCount;
          updateData.lastFailureReason = result.error;

          if (!isPermanent) {
            const delayMinutes =
              config.jobs.retryBaseDelayMinutes * Math.pow(4, batchFile.sourceFile.retryCount);
            updateData.nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000);
          }
        }

        await tx.sourceFile.update({
          where: { id: batchFile.sourceFileId },
          data: updateData,
        });
      }

      // Update batch summary
      const batchStatus =
        summary.failed > 0 && summary.succeeded === 0
          ? 'failed'
          : summary.failed > 0 || summary.requires_review > 0
            ? 'completed_with_warnings'
            : 'completed';

      await tx.batch.update({
        where: { id: batchId },
        data: {
          status: batchStatus,
          connectivoBatchId: payload.batch.id,
          completedAt: new Date(payload.batch.completed_at),
          totalPages: summary.total_pages,
          succeeded: summary.succeeded,
          failed: summary.failed,
          requiresReview: summary.requires_review,
          totalIssuesFound: summary.total_issues_found,
          totalIssuesFixed: summary.total_issues_fixed,
        },
      });
    });

    // Re-queue any files flagged for resubmission (modified while processing)
    await this.handlePendingResubmits(batch.institution, batch.course);

    logger.info('RemediationService: results processed', { batchId });
  }

  private async handlePendingResubmits(
    institution: Institution,
    course: Course,
  ): Promise<void> {
    const filesToResubmit = await prisma.sourceFile.findMany({
      where: { courseId: course.id, pendingResubmit: true },
    });

    if (filesToResubmit.length === 0) return;

    logger.info('RemediationService: re-queuing files modified during processing', {
      courseId: course.id,
      count: filesToResubmit.length,
    });

    // Reset them to ready so BatchBuilder picks them up
    await prisma.sourceFile.updateMany({
      where: { id: { in: filesToResubmit.map((f) => f.id) } },
      data: { status: 'ready', pendingResubmit: false },
    });

    await this.batchBuilder.createBatch(institution, course, filesToResubmit, { isRetry: false });
  }
}
