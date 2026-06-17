import { BatchStatus, ConnectivoFileState, Prisma, QualityLabel } from '@prisma/client';
import prisma from '../../db/client';
import { ConnectivoResultsPayload, ConnectivoFileResult } from '../../types/connectivo';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/errors';
import { computeFailureUpdate } from '../../utils/failure';
import { writebackQueue } from '../../queue';

// Connectivo emits more state values than our Prisma enum. Anything not mapped
// (and not "Processing", handled separately) is treated as failed — with a warn
// log so a new Connectivo state doesn't silently mis-bucket.
const STATE_MAP: Record<string, ConnectivoFileState> = {
  Completed: 'completed',
  CompletedWithWarnings: 'completed_with_warnings',
  Failed: 'failed',
  Cancelled: 'failed',
  Skipped: 'skipped',
};

const QUALITY_MAP: Record<string, QualityLabel> = {
  Excellent: 'Excellent',
  Good: 'Good',
  RequiresReview: 'RequiresReview',
  'Requires Review': 'RequiresReview',
  Failed: 'Failed',
  Unchanged: 'Unchanged',
};

// Thrown out of the transaction when we detect a duplicate response (SQS at-
// least-once redelivery). Catching outside lets the transaction roll back —
// which is desirable because the only thing the transaction did was the failing
// batchResponse.create.
class AlreadyProcessedError extends Error {
  constructor() {
    super('AlreadyProcessed');
    this.name = 'AlreadyProcessedError';
  }
}

// Connectivo reports remediated_path as "/<bucket>/<key>". Parse both pieces so
// the writeback lookup doesn't depend on batch.requestS3Bucket (which is nullable
// for legacy rows). Robust against malformed inputs: extra leading slashes,
// missing bucket, and bucket-without-key. Exported for unit tests.
export function parseRemediatedPath(
  path: string,
): { bucket: string; key: string } | null {
  const trimmed = path.replace(/^\/+/, '');
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash === -1) {
    logger.warn('RemediationService: remediated_path lacks bucket prefix', { path });
    return null;
  }
  const bucket = trimmed.slice(0, firstSlash);
  const key = trimmed.slice(firstSlash + 1);
  if (bucket === '' || key === '') {
    logger.warn('RemediationService: remediated_path missing bucket or key', { path });
    return null;
  }
  return { bucket, key };
}

export class RemediationService {
  async handleResults(
    batchId: string,
    payload: ConnectivoResultsPayload,
    responseS3Key: string,
  ): Promise<void> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { batchFiles: { include: { sourceFile: true } } },
    });

    if (!batch) throw Errors.notFound('Batch');

    // No early "already terminal" gate: dedup is enforced inside the tx via the
    // batch_responses unique constraint, and a follow-up response.json with a new
    // s3_key is the retry-arrival case that should re-enter the loop. Crash-recovery
    // (handler died between tx commit and writeback enqueue) is handled in the
    // AlreadyProcessedError branch below, which re-invokes enqueueWritebacks.

    // Match response files to our batch_files via custom_fields.file_id (our sourceFileId).
    const fileResultMap = new Map<string, ConnectivoFileResult>();
    for (const folder of payload.folders) {
      for (const file of folder.files) {
        const fileId = file.custom_fields?.file_id;
        if (fileId) fileResultMap.set(fileId, file);
      }
    }

    const batchFileBySourceId = new Map(batch.batchFiles.map((bf) => [bf.sourceFileId, bf]));

    try {
      await prisma.$transaction(async (tx) => {
        // Serialize per-batch processing. Without this, two concurrent retries
        // for the same batch (different s3_keys) can both pass the unique
        // constraint and both read a stale responseCount under READ COMMITTED,
        // mis-classifying which one is "first" and racing on batch_file writes.
        // The advisory lock on the batch row blocks the second invocation here
        // until the first commits.
        await tx.$queryRaw`SELECT id FROM batches WHERE id = ${batchId} FOR UPDATE`;

        // Dedup. Unique constraint on s3_key blocks SQS redeliveries; the row
        // count immediately after insert tells us which attempt this is for the
        // batch (1 = first response, >1 = retry). The FOR UPDATE above means
        // the count is accurate even under concurrent same-batch deliveries.
        try {
          await tx.batchResponse.create({
            data: {
              batchId,
              s3Key: responseS3Key,
              connectivoBatchId: payload.batch.id,
            },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new AlreadyProcessedError();
          }
          throw err;
        }

        const responseCount = await tx.batchResponse.count({ where: { batchId } });
        const isFirstResponse = responseCount === 1;

        logger.info('RemediationService: processing results', {
          batchId,
          connectivoBatchId: payload.batch.id,
          responseCount,
          isFirstResponse,
        });

        // First response: any file missing from the payload is implicitly failed
        // (Connectivo contract: first response is complete). Retries are partial
        // by design — only touch files that appear in this response.
        if (isFirstResponse) {
          for (const batchFile of batch.batchFiles) {
            if (fileResultMap.has(batchFile.sourceFileId)) continue;
            const reason = 'Missing from Connectivo response';
            await tx.batchFile.update({
              where: { id: batchFile.id },
              data: { connectivoState: 'failed', errorMessage: reason },
            });
            const fu = computeFailureUpdate(batchFile.sourceFile, reason);
            // Same batchedModifiedAt guard as the per-file outcome writes below
            // — a newer batch may have already claimed this source_file.
            await tx.sourceFile.updateMany({
              where: {
                id: batchFile.sourceFileId,
                batchedModifiedAt: batchFile.sourceModifiedAt,
              },
              data: fu,
            });
          }
        }

        // Apply per-file updates for everything in this response.
        for (const [sourceFileId, result] of fileResultMap) {
          const batchFile = batchFileBySourceId.get(sourceFileId);
          if (!batchFile) {
            logger.warn('RemediationService: response references unknown file_id', {
              batchId,
              sourceFileId,
            });
            continue;
          }

          // "Processing" means Connectivo is still working on this file and will
          // emit a follow-up response with its terminal state. Leave the row alone.
          // Casing-insensitive guard because the widened z.string() schema would
          // otherwise let a casing change slip through and mis-bucket as failed.
          if (result.state.toLowerCase() === 'processing') {
            logger.info('RemediationService: file still processing, skipping update', {
              batchFileId: batchFile.id,
              sourceFileId,
            });
            continue;
          }

          const mappedState = STATE_MAP[result.state];
          if (!mappedState) {
            logger.warn('RemediationService: unknown Connectivo state, treating as failed', {
              batchFileId: batchFile.id,
              sourceFileId,
              state: result.state,
            });
          }
          const connectivoState: ConnectivoFileState = mappedState ?? 'failed';
          const qualityLabel = result.quality_label
            ? (QUALITY_MAP[result.quality_label] ?? null)
            : null;
          // Connectivo reports remediated_path as "/<bucket>/<key>". Parse both
          // pieces — the bucket comes from the response (not batch.requestS3Bucket,
          // which is nullable and not guaranteed to be the same bucket Connectivo
          // wrote to).
          const remediatedLocation = result.remediated_path
            ? parseRemediatedPath(result.remediated_path)
            : null;
          const remediatedS3Key = remediatedLocation?.key ?? null;
          const remediatedS3Bucket = remediatedLocation?.bucket ?? null;

          await tx.batchFile.update({
            where: { id: batchFile.id },
            data: {
              connectivoState,
              qualityLabel,
              remediatedS3Key,
              remediatedS3Bucket,
              totalPages: result.total_pages,
              processingTimeSecs: result.processing_time_seconds,
              complianceErrors: result.compliance_errors,
              complianceWarnings: result.compliance_warnings,
              totalIssuesFound: result.total_issues_found,
              totalIssuesFixed: result.total_issues_fixed,
              errorMessage: result.error ?? null,
            },
          });

          // Issues JSON shape can change between attempts. Replace per-batch_file
          // rather than upserting per (batchFileId, category).
          await tx.fileIssueCategory.deleteMany({ where: { batchFileId: batchFile.id } });
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
          } else if (connectivoState === 'skipped') {
            await tx.sourceFile.updateMany({
              where: { id: batchFile.sourceFileId, batchedModifiedAt: batchFile.sourceModifiedAt },
              data: { lastOutcome: 'skipped', lastFailureReason: null },
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

        // Derive cumulative batch summary from batch_file rows. We don't trust
        // payload.batch.summary because (a) on retries it only covers retried
        // files, and (b) Connectivo's own data_integrity_warning shows their
        // rollup excludes Processing files from the totals.
        //
        // Bucketing rule (verified empirically from production response payloads):
        //   skipped         = connectivoState = 'skipped'             (no Batch counter)
        //   succeeded       = quality_label ∈ {Excellent, Good}
        //   requires_review = quality_label = RequiresReview
        //   failed          = quality_label = Failed (or null on a terminal row)
        // Files with connectivoState=NULL (still Processing) are excluded.
        // The connectivoState check comes BEFORE qualityLabel because Connectivo
        // sometimes emits Skipped files without a quality_label, which would
        // otherwise fall into the null→failed default.
        const rollupRows = await tx.batchFile.findMany({
          where: { batchId, connectivoState: { not: null } },
          select: {
            connectivoState: true,
            qualityLabel: true,
            totalPages: true,
            totalIssuesFound: true,
            totalIssuesFixed: true,
          },
        });

        let succeeded = 0;
        let failed = 0;
        let requiresReview = 0;
        let totalPages = 0;
        let totalIssuesFound = 0;
        let totalIssuesFixed = 0;
        for (const r of rollupRows) {
          totalPages += r.totalPages ?? 0;
          totalIssuesFound += r.totalIssuesFound ?? 0;
          totalIssuesFixed += r.totalIssuesFixed ?? 0;
          if (r.connectivoState === 'skipped') continue;
          switch (r.qualityLabel) {
            case 'Excellent':
            case 'Good':
              succeeded++;
              break;
            case 'RequiresReview':
              requiresReview++;
              break;
            case 'Failed':
              failed++;
              break;
            case 'Unchanged':
              // Defensive: Unchanged usually correlates with skipped state and
              // would have been short-circuited above. Don't count it.
              break;
            default:
              // Null quality_label on a non-skipped terminal-state row → failed.
              failed++;
              break;
          }
        }

        // Stay in 'pending' until every batch_file has a terminal state. Otherwise
        // a partially-completed batch could be re-claimed by SyncOrchestrator
        // (which gates on status === 'pending' for in-flight detection) while
        // Connectivo is still working on the remaining files.
        const inFlightCount = await tx.batchFile.count({
          where: { batchId, connectivoState: null },
        });

        let batchStatus: BatchStatus;
        if (inFlightCount > 0 || rollupRows.length === 0) {
          batchStatus = 'pending';
        } else if (failed > 0 && succeeded === 0 && requiresReview === 0) {
          batchStatus = 'failed';
        } else if (failed > 0 || requiresReview > 0) {
          batchStatus = 'completed_with_warnings';
        } else {
          batchStatus = 'completed';
        }

        // completedAt = "last activity timestamp." Take the max of any prior value
        // and the current payload's completed_at (clamped to no-future). This way
        // a retry whose completed_at predates the first response's doesn't pull
        // the column backwards.
        const connectivoCompletedAt = new Date(payload.batch.completed_at).getTime();
        const clampedNew = Math.min(Date.now(), connectivoCompletedAt);
        const existingCompletedAtMs = batch.completedAt?.getTime() ?? 0;
        const completedAt = new Date(Math.max(clampedNew, existingCompletedAtMs));

        await tx.batch.update({
          where: { id: batchId },
          data: {
            status: batchStatus,
            connectivoBatchId: payload.batch.id,
            completedAt,
            totalPages,
            succeeded,
            failed,
            requiresReview,
            totalIssuesFound,
            totalIssuesFixed,
            numRetries: isFirstResponse ? 0 : responseCount - 1,
          },
        });

        logger.info('RemediationService: results processed', {
          batchId,
          isFirstResponse,
          numRetries: isFirstResponse ? 0 : responseCount - 1,
        });
      });
    } catch (err) {
      if (err instanceof AlreadyProcessedError) {
        // Crash-recovery path: the original handler may have committed the tx but
        // died before enqueuing writebacks. Run the idempotent producer again so
        // missed writebacks catch up.
        //
        // CRITICAL: swallow any error here. Propagating would let SQS redrive the
        // response message, which would re-enter this same catch branch and loop
        // until DLQ for a problem that's already partially handled. The admin
        // backfill endpoint is the recovery path for persistent enqueue failures.
        logger.info(
          'RemediationService: response already processed, re-checking writeback enqueue',
          { batchId, responseS3Key },
        );
        try {
          await this.enqueueWritebacks(batchId);
        } catch (enqueueErr) {
          logger.error('RemediationService: crash-recovery enqueue failed, accepting loss', {
            batchId,
            error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          });
        }
        return;
      }
      throw err;
    }

    // Normal path: tx committed, fan out writeback jobs for eligible files. The
    // worker re-checks eligibility — this producer filter just avoids enqueueing
    // jobs that are obviously not actionable (no remediated bytes, non-completed
    // state, opt-out, superseded).
    await this.enqueueWritebacks(batchId);
  }

  // Idempotent: safe to call multiple times for the same batch. SQS redrives,
  // crash-recovery from a re-delivered response, and the admin opt-in backfill
  // all use this path to catch up — already-written files are skipped,
  // already-superseded ones are skipped, and per-send failures don't abandon
  // the rest of the batch.
  async enqueueWritebacks(batchId: string): Promise<void> {
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

      // Dedupe — three cases where we don't re-enqueue for the current version:
      //   1. 'written' AND lastWritebackModifiedAt > sourceModifiedAt
      //      A successful writeback stamps Canvas's post-upload timestamp, which is
      //      strictly after sourceModifiedAt.
      //   2. 'skipped_stale'
      //      Canvas drift was detected last time we tried this version; the consumer
      //      would skip again. Re-enqueueing wastes SQS messages until DLQ.
      //   3. 'queued'
      //      A manual replace already has a writeback job in flight for this version;
      //      enqueueing again would duplicate the Canvas write.
      // These states are reset by BatchBuilder when a new batch claims the source_file
      // (newer batchedModifiedAt), so they always refer to the current cycle here.
      const alreadyHandledForVersion =
        (sf.writebackState === 'written' &&
          sf.lastWritebackModifiedAt !== null &&
          sf.lastWritebackModifiedAt.getTime() > bf.sourceModifiedAt.getTime()) ||
        sf.writebackState === 'skipped_stale' ||
        sf.writebackState === 'queued' ||
        // A writeback worker is actively leasing this version — don't re-enqueue.
        sf.writebackState === 'in_progress';
      return !alreadyHandledForVersion;
    });

    if (eligible.length === 0) return;

    // Fan out SQS sends in parallel. Sequential awaits put 100ms+ of latency per
    // file on the response handler's hot path; for large batches that adds up to
    // tens of seconds — and would also blow the admin-backfill endpoint past the
    // API Gateway 30s timeout. SQS happily takes hundreds of concurrent SendMessage
    // calls per client. Per-file error isolation is preserved via allSettled.
    const results = await Promise.allSettled(
      eligible.map((bf) => writebackQueue.send({ batchFileId: bf.id })),
    );

    let sent = 0;
    let failed = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        sent++;
      } else {
        failed++;
        logger.error('RemediationService: writeback enqueue failed, continuing', {
          batchId,
          batchFileId: eligible[i].id,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    });

    logger.info('RemediationService: writeback jobs enqueued', { batchId, sent, failed });

    // Throw on partial failure so SQS redrives the response message. The dedupe +
    // supersession filters above make redelivery idempotent (already-sent jobs are
    // skipped). Returning success on a partial failure would silently lose work.
    if (failed > 0) {
      throw new Error(
        `Writeback enqueue partially failed for batch ${batchId}: sent=${sent} failed=${failed}`,
      );
    }
  }
}
