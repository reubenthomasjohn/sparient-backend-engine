import { s3Service } from '../../services/storage/S3Service';
import { RemediationService } from '../../services/remediation/RemediationService';
import { connectivoResultsSchema } from '../../types/connectivo';
import { logger } from '../../utils/logger';

const remediationService = new RemediationService();

export interface ResponseJob {
  prefix: string;
  key: string;    // key WITHOUT the prefix (e.g. <instId>/<courseId>/<batchId>.json)
}

export async function handleResponseJob(job: ResponseJob): Promise<void> {
  const batchId = parseBatchIdFromKey(job.key);
  if (!batchId) {
    logger.warn('Responses: skipping unparseable key', { key: job.key });
    return;
  }

  logger.info('Responses: fetching response.json', { prefix: job.prefix, key: job.key, batchId });
  const raw = await s3Service.getJson<unknown>(job.prefix, job.key);

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
