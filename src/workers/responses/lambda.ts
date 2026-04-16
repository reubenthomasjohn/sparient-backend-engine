import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { handleResponseJob } from './handler';
import { logger } from '../../utils/logger';

// SQS receives S3 event notifications when Connectivo writes a response.json into
// the responses bucket. Each SQS message has an "s3" envelope; we extract bucket+key
// and hand off to the handler.
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
      // S3 → SQS notifications batch up to N records per message; process all of them.
      for (const r of s3Event.Records) {
        await handleResponseJob({
          bucket: r.s3.bucket.name,
          // S3 URL-encodes object keys in event payloads. decodeURIComponent restores spaces etc.
          key: decodeURIComponent(r.s3.object.key.replace(/\+/g, ' ')),
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
