import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { DiscoveryJob } from '../../queue';
import { handleDiscoveryJob } from './handler';
import { logger } from '../../utils/logger';

// AWS Lambda entry. Configure the function with the discovery SQS queue as its event source.
// Partial-batch failure support: messages that throw are returned as itemFailures so SQS
// redrives only those, not the whole batch.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as DiscoveryJob;
      await handleDiscoveryJob(job);
    } catch (err) {
      logger.error('Discovery Lambda: record failed', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
