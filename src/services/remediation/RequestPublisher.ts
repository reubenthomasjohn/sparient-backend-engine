import { Batch, BatchFile, Course, Institution, SourceFile } from '@prisma/client';
import prisma from '../../db/client';
import { S3_PREFIX } from '../../config/s3Prefixes';
import { s3Service } from '../storage/S3Service';
import { ConnectivoBatchPayload } from '../../types/connectivo';
import { logger } from '../../utils/logger';

type BatchFileWithSource = BatchFile & { sourceFile: SourceFile };

// Transforms our internal data model into the Connectivo-facing request.json contract.
// Keeps the two decoupled — internal schema can evolve independently of what Connectivo expects.
function toConnectivoPayload(
  batch: Batch,
  institution: Institution,
  course: Course,
  batchFiles: BatchFileWithSource[],
  s3Bucket: string,
  forceReprocess: boolean,
): ConnectivoBatchPayload {
  const folderPath = `${s3Bucket}/${S3_PREFIX.SOURCE}/${institution.id}/${course.canvasCourseId}/`;

  return {
    batch_id: batch.id,
    // TODO: currently batch.createdAt (DB row creation time). Consider using the actual
    // S3 publish timestamp or the latest file modified_at in the batch.
    submitted_at: batch.createdAt.toISOString(),
    force_reprocess: forceReprocess,
    folders: [
      {
        path: folderPath,
        files: batchFiles.map((bf) => ({
          // Path fragment relative to folderPath: <canvasFileId>/v-<ms>/<fileName>
          name: `${bf.canvasFileId}/v-${bf.sourceModifiedAt.getTime()}/${bf.sourceFile.fileName}`,
          file_id: bf.sourceFileId,
          canvas_file_id: bf.canvasFileId,
        })),
      },
    ],
  };
}

export class RequestPublisher {
  buildKey(institutionId: string, canvasCourseId: string, batchId: string): string {
    return `${institutionId}/${canvasCourseId}/${batchId}.json`;
  }

  async publish(
    batch: Batch,
    institution: Institution,
    course: Course,
    s3Bucket: string,
    forceReprocess = false,
  ): Promise<void> {
    const batchFiles = await prisma.batchFile.findMany({
      where: { batchId: batch.id },
      include: { sourceFile: true },
    });

    const key = this.buildKey(institution.id, course.canvasCourseId, batch.id);
    const payload = toConnectivoPayload(batch, institution, course, batchFiles, s3Bucket, forceReprocess);

    await s3Service.putJson(s3Bucket, S3_PREFIX.REQUESTS, key, payload);

    await prisma.batch.update({
      where: { id: batch.id },
      data: {
        requestS3Bucket: s3Bucket,
        requestS3Key: `${S3_PREFIX.REQUESTS}/${key}`,
        requestWrittenAt: new Date(),
      },
    });

    logger.info('RequestPublisher: published', {
      batchId: batch.id,
      key,
      fileCount: batchFiles.length,
      forceReprocess,
    });
  }
}

export const requestPublisher = new RequestPublisher();
