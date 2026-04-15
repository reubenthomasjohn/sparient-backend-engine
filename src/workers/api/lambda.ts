import serverlessExpress from '@codegenie/serverless-express';
import type { Context } from 'aws-lambda';
import app from '../../app';
import prisma from '../../db/client';
import { logger } from '../../utils/logger';

// API Gateway HTTP API entry. Reuses the Express app so there is no separate routing layer.
// Prisma opens its connection lazily on first query and that connection is reused across
// warm invocations of this Lambda.
let warmed = false;
async function warm(): Promise<void> {
  if (warmed) return;
  await prisma.$connect();
  logger.info('API Lambda: prisma connected');
  warmed = true;
}

const inner = serverlessExpress({ app });

export const handler = async (event: unknown, context: Context): Promise<unknown> => {
  await warm();
  return inner(event, context, () => undefined);
};
