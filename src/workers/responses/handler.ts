import prisma from '../../db/client';
import { s3Service } from '../../services/storage/S3Service';
import { RemediationService } from '../../services/remediation/RemediationService';
import { connectivoResultsSchema } from '../../types/connectivo';
import {
  getEffectiveS3LayoutConfig,
  resolveResponseObjectKey,
} from '../../config/s3LayoutConfig';
import { getBucketName } from '../../config/s3Bucket';
import { Errors } from '../../utils/errors';
import { logger } from '../../utils/logger';

const remediationService = new RemediationService();

export interface ResponseJob {
  bucket: string;
  // Full S3 object key from the event, or a bare "<filename>.json" for admin replay.
  key: string;
  /** When set, skip institution lookup by bucket (admin replay). */
  institutionId?: string;
}

async function resolveLayoutForJob(job: ResponseJob) {
  if (job.institutionId) {
    const institution = await prisma.institution.findUnique({ where: { id: job.institutionId } });
    if (!institution) throw Errors.notFound('Institution');
    return {
      layout: getEffectiveS3LayoutConfig(institution),
      bucket: getBucketName(institution.id, institution.s3Bucket),
    };
  }

  const institution = await prisma.institution.findFirst({
    where: { s3Bucket: job.bucket },
  });
  if (!institution) {
    throw new Error(`No institution registered for S3 bucket ${job.bucket}`);
  }
  return { layout: getEffectiveS3LayoutConfig(institution), bucket: job.bucket };
}

export async function handleResponseJob(job: ResponseJob): Promise<void> {
  const { layout, bucket } = await resolveLayoutForJob(job);
  const objectKey = resolveResponseObjectKey(job.key, layout.responsesPrefix);

  logger.info('Responses: fetching json', { bucket, key: objectKey });
  const raw = await s3Service.getJsonByKey<unknown>(bucket, objectKey);

  const result = connectivoResultsSchema.safeParse(raw);
  if (!result.success) {
    logger.error('Responses: schema validation failed', {
      key: objectKey,
      firstError: result.error.issues[0]?.message,
      issueCount: result.error.issues.length,
    });
    throw new Error(
      `Connectivo response failed schema validation (key=${objectKey}): ${result.error.issues[0]?.message}`,
    );
  }

  const batchId = result.data.batch.external_batch_id;
  if (!batchId) {
    logger.error('Responses: empty external_batch_id, routing to DLQ', { key: objectKey });
    throw new Error(`Connectivo response has empty external_batch_id (key=${objectKey})`);
  }

  logger.info('Responses: processing', { batchId, key: objectKey });
  await remediationService.handleResults(batchId, result.data, objectKey);
}
