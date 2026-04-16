import serverlessExpress from '@codegenie/serverless-express';
import type { Context } from 'aws-lambda';
import app from '../../app';
import prisma from '../../db/client';
import { discoveryQueue, uploadQueue } from '../../queue';
import { InMemoryQueue } from '../../queue/InMemoryQueue';
import { handleDiscoveryJob } from '../discovery/handler';
import { handleUploadJob } from '../upload/handler';
import { logger } from '../../utils/logger';

// Single-Lambda deployment. Exposed via a Function URL (15-min timeout) so a force-sync
// can actually run to completion inline. No SQS, no EventBridge — /sync endpoints enqueue
// work to in-memory queues and we drain those before the handler returns.
//
// This only works because InMemoryQueue is used (SQS_*_URL unset). If you ever set those
// env vars on this Lambda, the queues become SQS and the drain loop becomes a no-op —
// work would be sent to SQS with nothing consuming it.

let warmed = false;
async function warm(): Promise<void> {
  if (warmed) return;
  await prisma.$connect();
  if (!(discoveryQueue instanceof InMemoryQueue) || !(uploadQueue instanceof InMemoryQueue)) {
    throw new Error(
      'monolith Lambda requires in-memory queues — unset SQS_DISCOVERY_URL / SQS_UPLOAD_URL',
    );
  }
  logger.info('Monolith Lambda: prisma connected, in-memory queues ready');
  warmed = true;
}

// Drain discovery first so upload jobs it produces land in the upload buffer, then drain
// uploads. Re-drain discovery afterward in case an upload retriggered discovery (unlikely
// but cheap). Repeat until both are empty.
async function drainAll(): Promise<void> {
  const discovery = discoveryQueue as InMemoryQueue<Parameters<typeof handleDiscoveryJob>[0]>;
  const upload   = uploadQueue    as InMemoryQueue<Parameters<typeof handleUploadJob>[0]>;

  for (let i = 0; i < 5; i++) {
    await discovery.drain(handleDiscoveryJob);
    await upload.drain(handleUploadJob);
    if (discovery['buffer'].length === 0 && upload['buffer'].length === 0) return;
  }
  logger.warn('Monolith Lambda: queues still non-empty after 5 drain passes');
}

const inner = serverlessExpress({ app });

export const handler = async (event: unknown, context: Context): Promise<unknown> => {
  await warm();
  const response = await inner(event, context, () => undefined);
  await drainAll();
  return response;
};
