import app from './app';
import { config } from './config';
import { logger } from './utils/logger';
import prisma from './db/client';
import { discoveryQueue } from './queue';
import { handleDiscoveryJob } from './workers/discovery/handler';

async function bootstrap(): Promise<void> {
  await prisma.$connect();
  logger.info('Database connected');

  const server = app.listen(config.app.port, () => {
    logger.info(`Server listening on port ${config.app.port}`, {
      env: config.app.nodeEnv,
    });
  });

  // In local dev (no SQS URL), the in-memory queue runs the discovery consumer in-process.
  // Upload fan-out is handled by Step Functions in prod. In local dev, uploads run inline
  // via the SyncOrchestrator's fallback path.
  if (config.queue.startConsumers) {
    discoveryQueue.startConsumer(handleDiscoveryJob);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(async () => {
      await discoveryQueue.stop();
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
