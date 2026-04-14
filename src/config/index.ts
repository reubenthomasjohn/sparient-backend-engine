import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  app: z.object({
    port: z.coerce.number().default(3000),
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
    logLevel: z.string().default('info'),
  }),
  db: z.object({
    url: z.string().min(1, 'DATABASE_URL is required'),
  }),
  aws: z.object({
    accessKeyId: z.string().min(1, 'AWS_ACCESS_KEY_ID is required'),
    secretAccessKey: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required'),
    region: z.string().default('us-east-1'),
    s3SourceBucket: z.string().min(1, 'S3_SOURCE_BUCKET is required'),
    s3RemediatedBucket: z.string().min(1, 'S3_REMEDIATED_BUCKET is required'),
  }),
  connectivo: z.object({
    apiKeySecret: z.string().min(1, 'CONNECTIVO_API_KEY_SECRET is required'),
  }),
  jobs: z.object({
    syncCronSchedule: z.string().default('0 2 * * *'),
    retryCronSchedule: z.string().default('0 */2 * * *'),
    retryBaseDelayMinutes: z.coerce.number().default(30),
  }),
  // If queue URLs are set, SqsQueue is used; otherwise InMemoryQueue runs in-process.
  // Local dev can leave these unset — the consumers are started by server.ts.
  queue: z.object({
    discoveryUrl: z.string().optional(),
    uploadUrl: z.string().optional(),
    startConsumers: z.coerce.boolean().default(true),
  }),
});

const parsed = configSchema.safeParse({
  app: {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
  },
  db: {
    url: process.env.DATABASE_URL,
  },
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
    s3SourceBucket: process.env.S3_SOURCE_BUCKET,
    s3RemediatedBucket: process.env.S3_REMEDIATED_BUCKET,
  },
  connectivo: {
    apiKeySecret: process.env.CONNECTIVO_API_KEY_SECRET,
  },
  jobs: {
    syncCronSchedule: process.env.SYNC_CRON_SCHEDULE,
    retryCronSchedule: process.env.RETRY_CRON_SCHEDULE,
    retryBaseDelayMinutes: process.env.RETRY_BASE_DELAY_MINUTES,
  },
  queue: {
    discoveryUrl: process.env.SQS_DISCOVERY_URL,
    uploadUrl: process.env.SQS_UPLOAD_URL,
    startConsumers: process.env.QUEUE_START_CONSUMERS,
  },
});

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const config = parsed.data;
