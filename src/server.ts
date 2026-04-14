import app from './app';
import { config } from './config';
import { logger } from './utils/logger';
import prisma from './db/client';
import { startNightlySyncJob } from './jobs/nightlySync.job';
import { startRetryJob } from './jobs/retry.job';
import { discoveryQueue, uploadQueue } from './queue';
import { handleDiscoveryJob } from './workers/discovery/handler';
import { handleUploadJob } from './workers/upload/handler';

async function bootstrap(): Promise<void> {
  await prisma.$connect();
  logger.info('Database connected');

  const server = app.listen(config.app.port, () => {
    logger.info(`Server listening on port ${config.app.port}`, {
      env: config.app.nodeEnv,
    });
  });

  startNightlySyncJob();
  startRetryJob();

  // In dev (no SQS URLs configured), the in-memory queue runs consumers in-process.
  // In prod, Lambda functions consume from SQS and QUEUE_START_CONSUMERS=false
  // on the API service prevents double-consumption.
  if (config.queue.startConsumers) {
    discoveryQueue.startConsumer(handleDiscoveryJob);
    uploadQueue.startConsumer(handleUploadJob);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(async () => {
      await Promise.all([discoveryQueue.stop(), uploadQueue.stop()]);
      await prisma.$disconnect();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
