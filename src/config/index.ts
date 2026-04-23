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
    // Optional — the SDK uses the default credential chain (Lambda role, env vars, ~/.aws).
    // Only needed if you want to override credentials explicitly (e.g. local dev with a
    // specific IAM user). Most setups leave these unset.
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    region: z.string().default('us-east-1'),
    s3SourceBucket: z.string().min(1, 'S3_SOURCE_BUCKET is required'),
    s3RemediatedBucket: z.string().min(1, 'S3_REMEDIATED_BUCKET is required'),
    s3RequestsBucket: z.string().min(1, 'S3_REQUESTS_BUCKET is required'),
    s3ResponsesBucket: z.string().min(1, 'S3_RESPONSES_BUCKET is required'),
    courseWorkflowArn: z.string().optional(), // SFN state machine ARN — set in prod, unset in local dev
  }),
  jobs: z.object({
    retryBaseDelayMinutes: z.coerce.number().default(30),
  }),
  // If queue URLs are set, SqsQueue is used; otherwise InMemoryQueue runs in-process.
  // Local dev can leave these unset — the consumers are started by server.ts.
  queue: z.object({
    discoveryUrl: z.string().optional(),
    startConsumers: z.coerce.boolean().default(true),
  }),
  accessHub: z.object({
    basicUser: z.string().min(1),
    basicPassword: z.string().min(1),
    /**
     * JSON map of signing secrets for HMAC-SHA256 auth (TASK-12 / §5.3).
     * Format: { "<institution_id>": "<secret>", "*": "<global_secret>" }
     * Key "*" = global deployment secret (any institution path allowed unless
     * ACCESS_HUB_SIGNING_ALLOWED_INSTITUTIONS restricts it).
     * Omit or leave empty to disable signed auth (Basic auth only).
     */
    signingSecrets: z.string().optional(),
    /**
     * Comma-separated institution UUIDs allowed for the global ("*") signing key.
     * Empty or absent = all institutions allowed for the global key.
     */
    signingAllowedInstitutions: z.string().optional(),
    /** Clock skew tolerance in seconds (default 300 = ±5 min). */
    signingSkewSeconds: z.coerce.number().default(300),
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
    s3RequestsBucket: process.env.S3_REQUESTS_BUCKET,
    s3ResponsesBucket: process.env.S3_RESPONSES_BUCKET,
    courseWorkflowArn: process.env.COURSE_WORKFLOW_ARN,
  },
  jobs: {
    retryBaseDelayMinutes: process.env.RETRY_BASE_DELAY_MINUTES,
  },
  queue: {
    discoveryUrl: process.env.SQS_DISCOVERY_URL,
    startConsumers: process.env.QUEUE_START_CONSUMERS,
  },
  accessHub: {
    basicUser: process.env.ACCESS_HUB_BASIC_USER || 'access-hub',
    basicPassword: process.env.ACCESS_HUB_BASIC_PASSWORD || 'local-dev-secret',
    signingSecrets: process.env.ACCESS_HUB_SIGNING_SECRETS,
    signingAllowedInstitutions: process.env.ACCESS_HUB_SIGNING_ALLOWED_INSTITUTIONS,
    signingSkewSeconds: process.env.ACCESS_HUB_SIGNING_SKEW_SECONDS,
  },
});

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

const configData = parsed.data;

if (
  configData.app.nodeEnv === 'production' &&
  configData.accessHub.basicPassword === 'local-dev-secret'
) {
  console.error(
    'ACCESS_HUB_BASIC_PASSWORD must be set to a non-default value in production.',
  );
  process.exit(1);
}

export const config = configData;
