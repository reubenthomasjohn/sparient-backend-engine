import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { handleResponseJob } from './handler';
import { logger } from '../../utils/logger';

interface S3EventRecord {
  s3: { bucket: { name: string }; object: { key: string } };
}
interface S3Event {
  Records: S3EventRecord[];
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const s3Event = JSON.parse(record.body) as S3Event;
      for (const r of s3Event.Records) {
        const key = decodeURIComponent(r.s3.object.key.replace(/\+/g, ' '));

        await handleResponseJob({
          bucket: r.s3.bucket.name,
          key,
        });
      }
    } catch (err) {
      logger.error('Responses Lambda: record failed', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
