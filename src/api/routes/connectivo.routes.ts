import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../db/client';
import { apiKeyAuth, getAuthInstitutionId } from '../middleware/apiKeyAuth.middleware';
import { RemediationService } from '../../services/remediation/RemediationService';
import { ConnectivoBatchPayload } from '../../types/connectivo';
import { Errors } from '../../utils/errors';
import { config } from '../../config';

const router = Router();
const remediationService = new RemediationService();

const acknowledgeSchema = z.object({
  connectivo_batch_id: z.string().min(1),
});

router.use(apiKeyAuth);

// GET /connectivo/batches
// Scoped keys see only their institution's batches; global keys see all.
router.get('/batches', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const authInstitutionId = getAuthInstitutionId(res);

    const batches = await prisma.batch.findMany({
      where: {
        status: 'pending',
        ...(authInstitutionId ? { institutionId: authInstitutionId } : {}),
      },
      include: {
        institution: true,
        course: true,
        batchFiles: { include: { sourceFile: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const payload: ConnectivoBatchPayload[] = batches.map((batch) => ({
      batch_id: batch.id,
      created_at: batch.createdAt.toISOString(),
      source_system: batch.institution.sourceType,
      institution_id: batch.institutionId,
      course_id: batch.course.canvasCourseId,
      s3_source_bucket: config.aws.s3SourceBucket,
      files: batch.batchFiles.map((bf) => ({
        file_id: bf.sourceFileId,
        canvas_file_id: bf.canvasFileId,
        file_name: bf.sourceFile.fileName,
        mime_type: bf.sourceFile.mimeType,
        size_bytes: bf.sourceFile.sizeBytes ? Number(bf.sourceFile.sizeBytes) : null,
        s3_key: bf.s3SourceKey,
      })),
    }));

    res.json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

// POST /connectivo/batches/:batchId/acknowledge
router.post(
  '/batches/:batchId/acknowledge',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authInstitutionId = getAuthInstitutionId(res);
      const { batchId } = req.params;
      const body = acknowledgeSchema.parse(req.body);

      const batch = await prisma.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw Errors.notFound('Batch');

      if (authInstitutionId !== null && batch.institutionId !== authInstitutionId) {
        throw Errors.forbidden('Batch does not belong to the authenticated institution');
      }

      // Idempotent ack: same external id on an already-processing batch returns OK
      // rather than 409. Different external id still errors.
      if (batch.status === 'processing') {
        if (batch.connectivoBatchId === body.connectivo_batch_id) {
          res.json({ success: true, data: { batch_id: batch.id, status: batch.status } });
          return;
        }
        throw Errors.conflict(`Batch already acknowledged with a different external id`);
      }

      if (batch.status !== 'pending') {
        throw Errors.conflict(`Batch is already in status '${batch.status}'`);
      }

      const updated = await prisma.batch.update({
        where: { id: batchId },
        data: {
          status: 'processing',
          connectivoBatchId: body.connectivo_batch_id,
          acknowledgedAt: new Date(),
        },
      });

      res.json({ success: true, data: { batch_id: updated.id, status: updated.status } });
    } catch (err) {
      next(err);
    }
  },
);

// POST /connectivo/batches/:batchId/results
router.post(
  '/batches/:batchId/results',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authInstitutionId = getAuthInstitutionId(res);
      const { batchId } = req.params;
      await remediationService.handleResults(batchId, req.body, authInstitutionId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
