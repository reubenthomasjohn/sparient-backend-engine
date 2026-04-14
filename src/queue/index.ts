import { config } from '../config';
import { Queue } from './IQueue';
import { InMemoryQueue } from './InMemoryQueue';
import { SqsQueue } from './SqsQueue';

// Enqueued by the nightly cron and manual /sync triggers.
export interface DiscoveryJob {
  institutionId: string;
  courseId?: string;   // Canvas course ID; if omitted, every active-term course is synced
  force?: boolean;
}

// Enqueued by the discovery worker and the retry job. The modifiedAt is the signal
// this message is tied to — workers drop the message if discoveredModifiedAt has since advanced.
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
