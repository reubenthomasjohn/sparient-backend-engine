import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../db/client';
import { apiKeyAuth } from '../middleware/apiKeyAuth.middleware';
import { RemediationService } from '../../services/remediation/RemediationService';
import { ConnectivoBatchPayload } from '../../types/connectivo';
import { Errors } from '../../utils/errors';
import { config } from '../../config';

const router = Router();
const remediationService = new RemediationService();

const acknowledgeSchema = z.object({
  connectivo_batch_id: z.string().min(1),
});

// All Connectivo routes require API key authentication
router.use(apiKeyAuth);

// GET /connectivo/batches
// Returns all pending batches with the file payload Connectivo needs to begin processing
router.get('/batches', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const batches = await prisma.batch.findMany({
      where: { status: 'pending' },
      include: {
        institution: true,
        course: true,
        batchFiles: {
          include: { sourceFile: true },
        },
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
        canvas_file_id: bf.sourceFile.canvasFileId,
        file_name: bf.sourceFile.fileName,
        mime_type: bf.sourceFile.mimeType,
        size_bytes: bf.sourceFile.sizeBytes ? Number(bf.sourceFile.sizeBytes) : null,
        s3_key: bf.sourceFile.s3SourceKey ?? '',
      })),
    }));

    res.json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

// POST /connectivo/batches/:batchId/acknowledge
// Connectivo calls this to confirm it has received and will process the batch
router.post(
  '/batches/:batchId/acknowledge',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { batchId } = req.params;
      const body = acknowledgeSchema.parse(req.body);

      const batch = await prisma.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw Errors.notFound('Batch');
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
// Connectivo posts remediation results for a completed batch
router.post(
  '/batches/:batchId/results',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { batchId } = req.params;
      await remediationService.handleResults(batchId, req.body);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
