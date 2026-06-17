import prisma from '../../db/client';
import { SourceRegistry } from '../sources/SourceRegistry';
import { logger } from '../../utils/logger';

// Lease window for the in_progress claim: longer than worst-case worker runtime (Lambda
// 150s), shorter than queue visibility (900s). Blocks live duplicates, but lets a crashed
// worker's stranded row be reclaimed on the next redrive.
const WRITEBACK_LEASE_MS = 600_000; // 10 min

// Pushes a remediated PDF back into Canvas for a single batch_file. Eligibility is
// re-checked here so a job superseded by a newer cycle becomes a no-op. At-least-once
// delivery is safe: replaceFile overwrites the same file id and the stamp is idempotent.
export class WritebackService {
  async writeBack(
    batchFileId: string,
    opts: { ignoreOptIn?: boolean; sourceFileId?: string } = {},
  ): Promise<void> {
    const batchFile = await prisma.batchFile.findUnique({
      where: { id: batchFileId },
      include: {
        sourceFile: { include: { course: { include: { institution: true } } } },
      },
    });

    if (!batchFile) {
      logger.warn('Writeback: batch_file not found, dropping', { batchFileId });
      // The batch_file was deleted between the manual replace enqueue and now. Use
      // the source_file id carried on the job to resolve a lingering 'queued' stamp.
      if (opts.sourceFileId) await this.resolveQueued(opts.sourceFileId);
      return;
    }

    const { sourceFile } = batchFile;
    const { course } = sourceFile;
    const { institution } = course;

    // Re-check eligibility under fresh DB state — it can change between enqueue and consume.
    if (
      batchFile.connectivoState !== 'completed' &&
      batchFile.connectivoState !== 'completed_with_warnings'
    ) {
      logger.info('Writeback: skip — not in a terminal completed state', {
        batchFileId,
        connectivoState: batchFile.connectivoState,
      });
      await this.resolveQueued(sourceFile.id);
      return;
    }

    if (!batchFile.remediatedS3Key || !batchFile.remediatedS3Bucket) {
      logger.info('Writeback: skip — no remediated S3 location', { batchFileId });
      await this.resolveQueued(sourceFile.id);
      return;
    }

    // ignoreOptIn (user-driven replace): a manual click is explicit consent, bypassing
    // the automatic-writeback opt-in gate.
    const optedIn = course.writebackOptIn ?? institution.writebackOptIn;
    if (!optedIn && !opts.ignoreOptIn) {
      logger.info('Writeback: skip — opt-out', { batchFileId, courseId: course.id });
      return;
    }

    // Supersession guard: a newer batch has claimed this source_file. Pushing
    // this older remediation would clobber whatever the newer cycle produces.
    if (
      sourceFile.batchedModifiedAt === null ||
      sourceFile.batchedModifiedAt.getTime() !== batchFile.sourceModifiedAt.getTime()
    ) {
      logger.info('Writeback: skip — superseded by newer batch', {
        batchFileId,
        sourceModifiedAt: batchFile.sourceModifiedAt,
        batchedModifiedAt: sourceFile.batchedModifiedAt,
      });
      // A manual replace optimistically marked this 'queued'; resolve it so the UI poll ends.
      await this.resolveQueued(sourceFile.id);
      return;
    }

    // Lease-claim as in_progress before pushing: a duplicate delivery finds a fresh lease and
    // skips (no double push), while a stale lease from a crashed worker stays reclaimable.
    const now = new Date();
    const staleBefore = new Date(now.getTime() - WRITEBACK_LEASE_MS);
    const claim = await prisma.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        batchedModifiedAt: batchFile.sourceModifiedAt,
        // Claimable when not actively leased: non-in_progress state, OR null (Prisma's `not`
        // doesn't match null, so list it explicitly), OR a stale lease from a crashed worker.
        OR: [
          { writebackState: { not: 'in_progress' } },
          { writebackState: null },
          { writebackStartedAt: { lt: staleBefore } },
        ],
      },
      data: { writebackState: 'in_progress', writebackStartedAt: now },
    });
    if (claim.count === 0) {
      logger.info('Writeback: another worker holds the in-progress lease, skipping', {
        batchFileId,
        sourceFileId: sourceFile.id,
      });
      return;
    }

    const sourceClient = await SourceRegistry.getClient(institution);

    // Bytes are PDFs by contract (Connectivo output), so set MIME explicitly.
    // knownModifiedAt is the version we actually remediated, not discoveredModifiedAt —
    // using the latter could overwrite a teacher's newer Canvas edit with a stale PDF.
    const result = await sourceClient.replaceFile({
      fileExternalId: sourceFile.canvasFileId,
      knownModifiedAt: batchFile.sourceModifiedAt,
      s3Bucket: batchFile.remediatedS3Bucket,
      s3Key: batchFile.remediatedS3Key,
      mimeType: 'application/pdf',
    });

    if (result.status === 'skipped') {
      // Only stamp if no successful terminal state exists — else a 'skipped' here would
      // clobber a prior cycle's 'written' whose Canvas timestamp sits beyond knownModifiedAt.
      await prisma.sourceFile.updateMany({
        where: {
          id: sourceFile.id,
          OR: [
            { writebackState: null },
            { writebackState: 'failed' },
            { writebackState: 'queued' },
            { writebackState: 'in_progress' },
          ],
        },
        data: { writebackState: 'skipped_stale' },
      });
      logger.info('Writeback: skipped (Canvas-side drift)', {
        batchFileId,
        sourceFileId: sourceFile.id,
        reason: result.reason,
      });
      return;
    }

    // Stamp the modifiedAt Canvas returned; FileChangeDetector reads it to skip our own
    // writebacks next discovery. Guarded by batchedModifiedAt so a slow writer for an older
    // batch can't clobber a newer batch's stamp (a no-op just leaves the newer bookkeeping).
    const { count } = await prisma.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        batchedModifiedAt: batchFile.sourceModifiedAt,
      },
      data: {
        writebackState: 'written',
        lastWritebackModifiedAt: result.file.modifiedAt,
      },
    });

    if (count === 0) {
      logger.warn('Writeback: succeeded but stamp skipped — newer batch already claimed source_file', {
        batchFileId,
        sourceFileId: sourceFile.id,
        canvasFileId: result.file.externalId,
      });
      return;
    }

    logger.info('Writeback: written to Canvas', {
      batchFileId,
      sourceFileId: sourceFile.id,
      canvasFileId: result.file.externalId,
      newModifiedAt: result.file.modifiedAt,
    });
  }

  // Resolve a lingering optimistic 'queued' stamp (manual replace route) to a terminal
  // state so the UI poll finishes. Guarded to 'queued', so a no-op on the automatic path.
  private async resolveQueued(sourceFileId: string): Promise<void> {
    await prisma.sourceFile.updateMany({
      where: { id: sourceFileId, writebackState: 'queued' },
      data: { writebackState: 'skipped_stale' },
    });
  }
}

export const writebackService = new WritebackService();
