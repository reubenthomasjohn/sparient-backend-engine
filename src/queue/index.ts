import { config } from '../config';
import { Queue } from './IQueue';
import { InMemoryQueue } from './InMemoryQueue';
import { SqsQueue } from './SqsQueue';

// Two message shapes on the discovery queue:
//   tick     — every 15 min (EventBridge). Checks which institutions are due → enqueues discovers.
//   discover — per institution (enqueued by tick or by /sync API routes).
//             Starts one Step Functions execution per course — no courseId on the queue message.
export type DiscoveryJob =
  | { type: 'tick' }
  | { type: 'discover'; institutionId: string; force?: boolean };

// UploadJob is still used as the data shape passed through Step Functions Map state.
// No longer enqueued to SQS — kept as a type.
export interface UploadJob {
  sourceFileId: string;
  modifiedAtMs: number;
  s3Bucket: string;
}

// One message per writeback-eligible batch_file. Enqueued by RemediationService once
// a batch goes terminal; consumed by the writeback worker which pushes the remediated
// PDF back into Canvas.
export interface WritebackJob {
  batchFileId: string;
  // Set by the user-driven replace endpoint. A manual click is explicit consent,
  // so the worker skips the institution/course writebackOptIn gate when this is true.
  ignoreOptIn?: boolean;
}

function build<T>(name: string, url?: string): Queue<T> {
  return url
    ? new SqsQueue<T>(name, url, config.aws.region)
    : new InMemoryQueue<T>(name);
}

export const discoveryQueue: Queue<DiscoveryJob> = build('discovery', config.queue.discoveryUrl);
export const writebackQueue: Queue<WritebackJob> = build('writeback', config.queue.writebackUrl);

export { Queue, MessageHandler } from './IQueue';
