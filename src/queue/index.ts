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
}

function build<T>(name: string, url?: string): Queue<T> {
  return url
    ? new SqsQueue<T>(name, url, config.aws.region)
    : new InMemoryQueue<T>(name);
}

export const discoveryQueue: Queue<DiscoveryJob> = build('discovery', config.queue.discoveryUrl);

export { Queue, MessageHandler } from './IQueue';
