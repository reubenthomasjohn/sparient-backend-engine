import prisma from '../../db/client';
import { s3Service } from '../../services/storage/S3Service';
import { RemediationService } from '../../services/remediation/RemediationService';
import { connectivoResultsSchema } from '../../types/connectivo';
import { S3_PREFIX } from '../../config/s3Prefixes';
import { logger } from '../../utils/logger';

const remediationService = new RemediationService();

export interface ResponseJob {
  bucket: string;
  key: string;       // key WITHOUT the responses prefix
}

export async function handleResponseJob(job: ResponseJob): Promise<void> {
  logger.info('Responses: fetching json', { bucket: job.bucket, key: job.key });
  const raw = await s3Service.getJson<unknown>(job.bucket, S3_PREFIX.RESPONSES, job.key);

  // Validate against the response schema. If it fails, this is likely the echoed
  // request.json that Connectivo copies into the same prefix — skip silently.
  const result = connectivoResultsSchema.safeParse(raw);
  if (!result.success) {
    logger.info('Responses: skipping non-response file (validation failed)', {
      key: job.key,
      firstError: result.error.issues[0]?.message,
    });
    return;
  }

  // Use external_batch_id from inside the payload (our batch ID) — don't parse from filename.
  // Connectivo's filename format varies (e.g. <timestamp>_job_completed_<batchId>.json).
  const batchId = result.data.batch.external_batch_id;
  if (!batchId) {
    logger.warn('Responses: no external_batch_id in response', { key: job.key });
    return;
  }

  logger.info('Responses: processing', { batchId, key: job.key });
  await remediationService.handleResults(batchId, result.data);
}
