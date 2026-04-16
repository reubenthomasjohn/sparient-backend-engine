import { Batch, Course, Institution } from '@prisma/client';
import prisma from '../../db/client';
import { config } from '../../config';
import { s3Service } from '../storage/S3Service';
import { ConnectivoBatchPayload } from '../../types/connectivo';
import { logger } from '../../utils/logger';

// Writes the per-batch request.json that Connectivo polls.
// Path convention: <institutionId>/<courseId>/<batchId>.json — same path in both
// the requests bucket (we write it) and the responses bucket (Connectivo writes it).
export class RequestPublisher {
  buildKey(institutionId: string, canvasCourseId: string, batchId: string): string {
    return `${institutionId}/${canvasCourseId}/${batchId}.json`;
  }

  async publish(batch: Batch, institution: Institution, course: Course): Promise<void> {
    const batchFiles = await prisma.batchFile.findMany({
      where: { batchId: batch.id },
      include: { sourceFile: true },
    });

    const key = this.buildKey(institution.id, course.canvasCourseId, batch.id);

    const payload: ConnectivoBatchPayload = {
      batch_id: batch.id,
      created_at: batch.createdAt.toISOString(),
      source_system: institution.sourceType,
      institution_id: institution.id,
      course_id: course.canvasCourseId,
      s3_source_bucket: config.aws.s3SourceBucket,
      s3_remediated_bucket: config.aws.s3RemediatedBucket,
      response_s3_bucket: config.aws.s3ResponsesBucket,
      response_s3_key: key,
      files: batchFiles.map((bf) => ({
        file_id: bf.sourceFileId,
        canvas_file_id: bf.canvasFileId,
        file_name: bf.sourceFile.fileName,
        mime_type: bf.sourceFile.mimeType,
        size_bytes: bf.sourceFile.sizeBytes ? Number(bf.sourceFile.sizeBytes) : null,
        s3_key: bf.s3SourceKey,
      })),
    };

    await s3Service.putJson(config.aws.s3RequestsBucket, key, payload);

    await prisma.batch.update({
      where: { id: batch.id },
      data: {
        requestS3Bucket: config.aws.s3RequestsBucket,
        requestS3Key: key,
        requestWrittenAt: new Date(),
      },
    });

    logger.info('RequestPublisher: published', {
      batchId: batch.id,
      key,
      fileCount: payload.files.length,
    });
  }
}

export const requestPublisher = new RequestPublisher();
