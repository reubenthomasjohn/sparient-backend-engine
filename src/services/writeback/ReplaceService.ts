import prisma from '../../db/client';
import { writebackQueue } from '../../queue';

// Connectivo states that mean "remediation finished and produced output worth pushing".
const COMPLETED_STATES = ['completed', 'completed_with_warnings'] as const;

export type ReplaceRejectionCode =
  | 'not_found'
  | 'no_completed_remediation'
  | 'no_remediated_output'
  | 'enqueue_failed';

export type ReplaceOutcome =
  | { status: 'accepted'; sourceFileId: string; batchFileId: string }
  | { status: 'rejected'; code: ReplaceRejectionCode; reason: string };

function reject(code: ReplaceRejectionCode, reason: string): ReplaceOutcome {
  return { status: 'rejected', code, reason };
}

// Resolve the latest eligible batch_file for a source_file and enqueue a manual writeback.
// Shared by the single + bulk Canvas-id replace endpoints so their eligibility and
// queue semantics can't drift. Always targets the version currently batched
// (sourceFile.batchedModifiedAt), so the caller never needs to know about batches or
// hit a "superseded" conflict. ignoreOptIn=true — a manual replace is explicit consent.
export async function enqueueReplaceForSourceFile(sourceFileId: string): Promise<ReplaceOutcome> {
  const sourceFile = await prisma.sourceFile.findUnique({
    where: { id: sourceFileId },
    select: { id: true, batchedModifiedAt: true, writebackState: true },
  });
  if (!sourceFile) return reject('not_found', 'File not found');
  if (sourceFile.batchedModifiedAt === null) {
    return reject('no_completed_remediation', 'File has no completed remediation to write back');
  }

  // The batch_file for the version currently batched. Newest first in case a version was
  // re-batched; the older row carries the same (sourceFileId, sourceModifiedAt).
  const batchFile = await prisma.batchFile.findFirst({
    where: { sourceFileId: sourceFile.id, sourceModifiedAt: sourceFile.batchedModifiedAt },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      connectivoState: true,
      remediatedS3Key: true,
      remediatedS3Bucket: true,
      sourceModifiedAt: true,
    },
  });
  if (
    !batchFile ||
    batchFile.connectivoState == null ||
    !(COMPLETED_STATES as readonly string[]).includes(batchFile.connectivoState)
  ) {
    return reject('no_completed_remediation', 'File has no completed remediation to write back');
  }
  if (!batchFile.remediatedS3Key || !batchFile.remediatedS3Bucket) {
    return reject('no_remediated_output', 'File has no remediated output to write back');
  }

  // Optimistically stamp 'queued' so the UI can tell an in-flight request from a stale
  // terminal state. Guarded on batchedModifiedAt so a newer batch arriving in the race
  // window between our read and here is never clobbered; count=0 means that happened, so
  // the version we resolved is no longer current — report it as not-eligible-now.
  const priorWritebackState = sourceFile.writebackState;
  const { count } = await prisma.sourceFile.updateMany({
    where: { id: sourceFile.id, batchedModifiedAt: batchFile.sourceModifiedAt },
    data: { writebackState: 'queued' },
  });
  if (count === 0) {
    return reject('no_completed_remediation', 'A newer remediation arrived; retry');
  }

  try {
    await writebackQueue.send({
      batchFileId: batchFile.id,
      ignoreOptIn: true,
      sourceFileId: sourceFile.id,
    });
  } catch {
    // The stamp landed but no job was enqueued. Roll back to the prior state so the UI
    // doesn't poll a phantom 'queued' forever. Guarded to 'queued' so we never undo a
    // terminal state a concurrent writer may have set in the meantime.
    await prisma.sourceFile.updateMany({
      where: { id: sourceFile.id, writebackState: 'queued' },
      data: { writebackState: priorWritebackState },
    });
    return reject('enqueue_failed', 'Failed to enqueue writeback job');
  }

  return { status: 'accepted', sourceFileId: sourceFile.id, batchFileId: batchFile.id };
}

// Candidate source_files in a course that have a completed remediation with output for
// the currently-batched version. The (sourceModifiedAt == batchedModifiedAt) tie can't be
// expressed as a column-to-column compare in Prisma, so this is a slightly loose prefilter;
// enqueueReplaceForSourceFile re-checks it exactly per file. Used by bulk-replace when no
// explicit canvasFileIds list is given. Returns {id, canvasFileId}.
export function findReplaceableSourceFiles(courseId: string) {
  return prisma.sourceFile.findMany({
    where: {
      courseId,
      batchedModifiedAt: { not: null },
      batchFiles: {
        some: {
          connectivoState: { in: [...COMPLETED_STATES] },
          remediatedS3Key: { not: null },
          remediatedS3Bucket: { not: null },
        },
      },
    },
    select: { id: true, canvasFileId: true },
  });
}
