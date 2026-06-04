import { Router, Request, Response, NextFunction } from 'express';
import { BatchStatus } from '@prisma/client';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';
import { writebackQueue } from '../../queue';

const router = Router();

// GET /batches/stuck?olderThanHours=24
// Returns pending batches whose request was written more than N hours ago — i.e.,
// Connectivo hasn't produced a response in time. Pure observability; no remediation.
router.get('/stuck', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hours = Number(req.query.olderThanHours ?? 24);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw Errors.badRequest('olderThanHours must be a positive number');
    }
    const cutoff = new Date(Date.now() - hours * 3_600_000);

    const stuck = await prisma.batch.findMany({
      where: {
        status: 'pending',
        requestWrittenAt: { not: null, lt: cutoff },
      },
      include: { institution: { select: { id: true, name: true, slug: true } }, course: true },
      orderBy: { requestWrittenAt: 'asc' },
    });

    res.json({ success: true, count: stuck.length, data: stuck });
  } catch (err) {
    next(err);
  }
});

// GET /batches/:batchId
router.get('/:batchId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = await prisma.batch.findUnique({
      where: { id: req.params.batchId },
      include: { institution: true, course: true },
    });

    if (!batch) throw Errors.notFound('Batch');

    res.json({ success: true, data: batch });
  } catch (err) {
    next(err);
  }
});

// GET /batches/:batchId/files
router.get('/:batchId/files', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batchFiles = await prisma.batchFile.findMany({
      where: { batchId: req.params.batchId },
      include: { sourceFile: true, issueCategories: true },
    });

    res.json({ success: true, data: batchFiles });
  } catch (err) {
    next(err);
  }
});

// POST /batches/:batchId/files/:batchFileId/acknowledge
// UI-only flag — marks the user as having reviewed this remediation result.
// Has no effect on the writeback pipeline (writeback is not gated on ack).
router.post(
  '/:batchId/files/:batchFileId/acknowledge',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { batchId, batchFileId } = req.params;
      const { count } = await prisma.batchFile.updateMany({
        where: { id: batchFileId, batchId },
        data: { reviewAcknowledged: true },
      });
      if (count === 0) throw Errors.notFound('BatchFile');
      res.json({ success: true, batchFileId });
    } catch (err) {
      next(err);
    }
  },
);

// GET /institutions/:institutionId/batches
router.get(
  '/institutions/:institutionId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;
      const { status, courseId } = req.query;

      const batches = await prisma.batch.findMany({
        where: {
          institutionId,
          ...(status ? { status: status as BatchStatus } : {}),
          ...(courseId ? { courseId: courseId as string } : {}),
        },
        include: { course: true },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: batches });
    } catch (err) {
      next(err);
    }
  },
);

// POST /batches/:batchId/files/:batchFileId/replace
// User-driven "push this remediated file back to Canvas now". Enqueues a writeback
// job with ignoreOptIn=true — a manual click is explicit consent, so it bypasses the
// institution/course auto opt-in gate. Async: stamps writebackState='queued' and
// returns 202; the worker re-checks every guard (Canvas drift, supersession) and
// stamps the terminal state. UI polls GET /batches/:batchId/files for
// sourceFile.writebackState (queued → written | skipped_stale | failed).
router.post(
  '/:batchId/files/:batchFileId/replace',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { batchId, batchFileId } = req.params;

      const batchFile = await prisma.batchFile.findFirst({
        where: { id: batchFileId, batchId },
        select: {
          connectivoState: true,
          remediatedS3Key: true,
          remediatedS3Bucket: true,
          sourceModifiedAt: true,
          sourceFileId: true,
          sourceFile: { select: { batchedModifiedAt: true, writebackState: true } },
        },
      });
      if (!batchFile) throw Errors.notFound('BatchFile');

      // Pre-checks mirror the worker's guards so the UI gets immediate feedback
      // instead of a silently-skipped async job. The worker re-checks under fresh
      // state anyway, and resolves a lingering 'queued' on every skip path, so a rare
      // post-stamp regression of these fields can't strand the UI's poll.
      if (
        batchFile.connectivoState !== 'completed' &&
        batchFile.connectivoState !== 'completed_with_warnings'
      ) {
        throw Errors.conflict('File has no completed remediation to write back');
      }
      if (!batchFile.remediatedS3Key || !batchFile.remediatedS3Bucket) {
        throw Errors.conflict('File has no remediated output to write back');
      }
      if (
        batchFile.sourceFile.batchedModifiedAt === null ||
        batchFile.sourceFile.batchedModifiedAt.getTime() !==
          batchFile.sourceModifiedAt.getTime()
      ) {
        throw Errors.conflict(
          'A newer remediation has superseded this file; replace from the latest batch',
        );
      }

      // Optimistically mark 'queued' so the UI can tell this in-flight request apart
      // from a stale terminal state on re-replace. Guarded on batchedModifiedAt so a
      // newer batch's stamp arriving in the race window between our pre-check and here
      // is never clobbered. count=0 means exactly that race happened — treat it as the
      // same supersession conflict the pre-check reports.
      const priorWritebackState = batchFile.sourceFile.writebackState;
      const { count } = await prisma.sourceFile.updateMany({
        where: {
          id: batchFile.sourceFileId,
          batchedModifiedAt: batchFile.sourceModifiedAt,
        },
        data: { writebackState: 'queued' },
      });
      if (count === 0) {
        throw Errors.conflict(
          'A newer remediation has superseded this file; replace from the latest batch',
        );
      }

      try {
        await writebackQueue.send({
          batchFileId,
          ignoreOptIn: true,
          sourceFileId: batchFile.sourceFileId,
        });
      } catch (err) {
        // The stamp landed but no job was enqueued. Roll it back to the prior state so
        // the UI doesn't poll a phantom 'queued' forever. Guarded to 'queued' so we
        // never undo a terminal state a concurrent writer may have set in the meantime.
        await prisma.sourceFile.updateMany({
          where: { id: batchFile.sourceFileId, writebackState: 'queued' },
          data: { writebackState: priorWritebackState },
        });
        throw err;
      }

      res.status(202).json({ success: true, status: 'queued', batchFileId });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
