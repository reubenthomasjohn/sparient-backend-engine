import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { handleResponseJob } from './handler';
import { S3_PREFIX } from '../../config/s3Prefixes';
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
        const fullKey = decodeURIComponent(r.s3.object.key.replace(/\+/g, ' '));
        // Strip the responses prefix from the key — handler works with prefix-relative keys.
        const prefixWithSlash = `${S3_PREFIX.RESPONSES}/`;
        const key = fullKey.startsWith(prefixWithSlash)
          ? fullKey.slice(prefixWithSlash.length)
          : fullKey;

        await handleResponseJob({ prefix: S3_PREFIX.RESPONSES, key });
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
