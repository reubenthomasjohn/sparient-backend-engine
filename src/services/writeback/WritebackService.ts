import prisma from '../../db/client';
import { SourceRegistry } from '../sources/SourceRegistry';
import { logger } from '../../utils/logger';

// Pushes a remediated PDF back into the source system (Canvas) for a single
// batch_file. Eligibility is re-checked at the worker so an enqueued job that
// has been superseded by a newer remediation cycle becomes a no-op.
//
// Idempotency: at-least-once delivery is fine. CanvasFileReplacer.replaceFile
// uses on_duplicate=overwrite against the same file id; a duplicate run
// re-uploads the same bytes. The post-write update of writebackState +
// lastWritebackModifiedAt is also idempotent.
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

    // Re-check eligibility under fresh DB state. The producer (RemediationService)
    // already filtered, but state can change between enqueue and consume.
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

    // ignoreOptIn is set by the user-driven replace endpoint: a manual click is
    // explicit consent, so it bypasses the gate that governs *automatic* writeback.
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
      // A manual replace may have optimistically marked this 'queued'; a newer batch
      // claimed the source_file before we ran. Resolve the lingering state so the
      // UI's poll terminates.
      await this.resolveQueued(sourceFile.id);
      return;
    }

    const sourceClient = await SourceRegistry.getClient(institution);

    // The bytes are PDFs by contract — Connectivo's output format. Use that MIME
    // explicitly rather than the source's mimeType, which may have been docx/pptx.
    //
    // knownModifiedAt is the version we *actually remediated* (batchFile.sourceModifiedAt),
    // not discoveredModifiedAt. If a teacher edited the file in Canvas between batch
    // creation and writeback, discoveredModifiedAt may have advanced past our remediated
    // version — using it here would let us overwrite their newer edit with a stale PDF.
    const result = await sourceClient.replaceFile({
      fileExternalId: sourceFile.canvasFileId,
      knownModifiedAt: batchFile.sourceModifiedAt,
      s3Bucket: batchFile.remediatedS3Bucket,
      s3Key: batchFile.remediatedS3Key,
      mimeType: 'application/pdf',
    });

    if (result.status === 'skipped') {
      // Same guard as the failure path: only stamp if no successful terminal state
      // is already recorded for this source_file. Without this, a 'skipped' from
      // *this* cycle would clobber a 'written' from a prior cycle whose Canvas-side
      // timestamp legitimately sits beyond our knownModifiedAt.
      await prisma.sourceFile.updateMany({
        where: {
          id: sourceFile.id,
          OR: [
            { writebackState: null },
            { writebackState: 'failed' },
            { writebackState: 'queued' },
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

    // Success: stamp the modifiedAt Canvas returned for the new upload. The
    // FileChangeDetector consults this exact value to skip our own writebacks
    // on the next discover pass.
    //
    // Guarded by batchedModifiedAt so a slow writer for an older batch doesn't
    // clobber a newer batch's stamp backwards. A no-op here means a newer cycle
    // already advanced past the version we just uploaded; the bytes are still in
    // Canvas (replace is idempotent) but the bookkeeping is the newer cycle's.
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

  // Resolves a lingering optimistic 'queued' stamp (set by the manual replace route)
  // to a terminal state so the UI's poll always finishes. Called on every skip path
  // that would otherwise return without stamping. Guarded to 'queued' so it never
  // touches a terminal state — a no-op on the automatic writeback path.
  private async resolveQueued(sourceFileId: string): Promise<void> {
    await prisma.sourceFile.updateMany({
      where: { id: sourceFileId, writebackState: 'queued' },
      data: { writebackState: 'skipped_stale' },
    });
  }
}

export const writebackService = new WritebackService();
