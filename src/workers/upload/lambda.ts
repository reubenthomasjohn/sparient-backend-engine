import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { UploadJob } from '../../queue';
import { handleUploadJob } from './handler';
import { logger } from '../../utils/logger';

// AWS Lambda entry. Configure with the upload SQS queue as the event source and
// ReportBatchItemFailures enabled so partial failures don't re-run successes.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as UploadJob;
      await handleUploadJob(job);
    } catch (err) {
      logger.error('Upload Lambda: record failed', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
