import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { handleWritebackJob } from './handler';
import { WritebackJob } from '../../queue';
import { logger } from '../../utils/logger';

// SQS-triggered Lambda. Failed records are returned as batch item failures so SQS
// redrives them individually rather than retrying the whole batch.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as WritebackJob;
      await handleWritebackJob(job);
    } catch (err) {
      logger.error('Writeback Lambda: record failed', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
