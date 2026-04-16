import { config } from '../config';
import { Queue } from './IQueue';
import { InMemoryQueue } from './InMemoryQueue';
import { SqsQueue } from './SqsQueue';

// Two message shapes on the discovery queue:
//   sweep   — once a day (EventBridge in prod, node-cron locally). The handler fans out
//             per-institution discovery jobs and re-queues retry-eligible files.
//   discover — one per institution (enqueued by sweep or by /sync API routes).
export type DiscoveryJob =
  | { type: 'sweep' }
  | { type: 'discover'; institutionId: string; courseId?: string; force?: boolean };

// Enqueued by the discovery worker and by the sweep (for retry-eligible files).
// The modifiedAt is the signal this message is tied to — workers drop the message
// if discoveredModifiedAt has since advanced.
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
export const uploadQueue: Queue<UploadJob> = build('upload', config.queue.uploadUrl);

export { Queue, MessageHandler } from './IQueue';
