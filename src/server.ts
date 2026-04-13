import app from './app';
import { config } from './config';
import { logger } from './utils/logger';
import prisma from './db/client';
import { startNightlySyncJob } from './jobs/nightlySync.job';
import { startRetryJob } from './jobs/retry.job';

async function bootstrap(): Promise<void> {
  // Verify DB connectivity before accepting traffic
  await prisma.$connect();
  logger.info('Database connected');

  const server = app.listen(config.app.port, () => {
    logger.info(`Server listening on port ${config.app.port}`, {
      env: config.app.nodeEnv,
    });
  });

  // Start background jobs
  startNightlySyncJob();
  startRetryJob();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(async () => {
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
