import { s3Service } from '../../services/storage/S3Service';
import { RemediationService } from '../../services/remediation/RemediationService';
import { connectivoResultsSchema } from '../../types/connectivo';
import { logger } from '../../utils/logger';

const remediationService = new RemediationService();

// One S3 event record per response.json that landed in the responses bucket.
// Path convention: <institutionId>/<courseId>/<batchId>.json
export interface ResponseJob {
  bucket: string;
  key: string;
}

export async function handleResponseJob(job: ResponseJob): Promise<void> {
  const batchId = parseBatchIdFromKey(job.key);
  if (!batchId) {
    logger.warn('Responses: skipping unparseable key', { key: job.key });
    return;
  }

  logger.info('Responses: fetching response.json', { bucket: job.bucket, key: job.key, batchId });
  const raw = await s3Service.getJson<unknown>(job.bucket, job.key);

  // Validate before processing — a malformed response gets a clear error in the logs
  // rather than a cryptic crash halfway through RemediationService.
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

// Path is <institutionId>/<courseId>/<batchId>.json — just take the last segment.
function parseBatchIdFromKey(key: string): string | null {
  const last = key.split('/').pop();
  if (!last || !last.endsWith('.json')) return null;
  return last.slice(0, -'.json'.length);
}
