import prisma from '../../db/client';
import { s3Service } from '../../services/storage/S3Service';
import { RemediationService } from '../../services/remediation/RemediationService';
import { connectivoResultsSchema } from '../../types/connectivo';
import { S3_PREFIX } from '../../config/s3Prefixes';
import { logger } from '../../utils/logger';

const remediationService = new RemediationService();

export interface ResponseJob {
  bucket: string;    // the actual S3 bucket name (from the S3 event)
  key: string;       // key WITHOUT the responses prefix
}

export async function handleResponseJob(job: ResponseJob): Promise<void> {
  const batchId = parseBatchIdFromKey(job.key);
  if (!batchId) {
    logger.warn('Responses: skipping unparseable key', { key: job.key });
    return;
  }

  logger.info('Responses: fetching response.json', { bucket: job.bucket, key: job.key, batchId });
  const raw = await s3Service.getJson<unknown>(job.bucket, S3_PREFIX.RESPONSES, job.key);

  const result = connectivoResultsSchema.safeParse(raw);
  if (!result.success) {
    logger.error('Responses: invalid response.json', {
      batchId,
      key: job.key,
      errors: result.error.issues,
    });
    throw new Error(`Invalid response.json for batch ${batchId}: ${result.error.message}`);
  }

  await remediationService.handleResults(batchId, result.data);
}

function parseBatchIdFromKey(key: string): string | null {
  const last = key.split('/').pop();
  if (!last || !last.endsWith('.json')) return null;
  return last.slice(0, -'.json'.length);
}
