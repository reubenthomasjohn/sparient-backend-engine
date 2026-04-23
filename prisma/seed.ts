import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  S3Client,
  PutBucketNotificationConfigurationCommand,
} from '@aws-sdk/client-s3';
// import { provisionInstitutionBucket } from '../src/services/storage/InstitutionBucketService';
// import { getBucketName } from '../src/config/s3Bucket';
import dotenv from 'dotenv';

dotenv.config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  console.log('Seeding database...\n');

  // ── Institution ────────────────────────────────────────────────────────────

  const canvasDomain    = requireEnv('CANVAS_DOMAIN');
  const canvasAccountId = requireEnv('CANVAS_ACCOUNT_ID');
  const canvasApiToken  = requireEnv('CANVAS_API_TOKEN');

  const rawSlug = process.env.INSTITUTION_SLUG ?? canvasDomain.split('.')[0];
  const slug = rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const institution = await prisma.institution.upsert({
    where: { slug },
    create: {
      name:          process.env.INSTITUTION_NAME ?? slug,
      slug,
      sourceType:    'canvas',
      credentials: {
        domain:     canvasDomain,
        account_id: canvasAccountId,
        api_token:  canvasApiToken,
      },
      writebackOptIn: false,
    },
    update: {
      credentials: {
        domain:     canvasDomain,
        account_id: canvasAccountId,
        api_token:  canvasApiToken,
      },
    },
  });

  console.log(`Institution: ${institution.name}`);
  console.log(`  ID:   ${institution.id}`);
  console.log(`  Slug: ${institution.slug}`);

  // ── S3 Bucket ──────────────────────────────────────────────────────────────

  // --- Standard path: create a per-institution bucket (uncomment when ready) ---
  // const bucketName = getBucketName(institution.id, institution.s3Bucket);
  // console.log(`  S3 bucket: ${bucketName}`);
  // try {
  //   await provisionInstitutionBucket(institution.id, institution.s3Bucket);
  //   console.log('  S3 bucket provisioned ✓\n');
  // } catch (err: any) {
  //   if (err?.Code === 'BucketAlreadyOwnedByYou' || err?.name === 'BucketAlreadyOwnedByYou') {
  //     console.log('  S3 bucket already exists ✓\n');
  //   } else {
  //     console.error('  S3 bucket provisioning failed:', err?.message ?? err);
  //   }
  // }

  // --- Hardcoded override: use an existing bucket ---
  // TODO: clean this up — use the standard path above + institution registration
  // endpoint instead of hardcoding. See docs/TODO.md.
  const HARDCODED_BUCKET = 'accesshub-remediation-storage';
  const SQS_RESPONSES_ARN = process.env.SQS_RESPONSES_QUEUE_ARN;

  await prisma.institution.update({
    where: { id: institution.id },
    data: { s3Bucket: HARDCODED_BUCKET },
  });
  console.log(`  S3 bucket: ${HARDCODED_BUCKET} (hardcoded override)`);

  if (SQS_RESPONSES_ARN) {
    try {
      const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-2' });
      await s3.send(new PutBucketNotificationConfigurationCommand({
        Bucket: HARDCODED_BUCKET,
        NotificationConfiguration: {
          QueueConfigurations: [{
            QueueArn: SQS_RESPONSES_ARN,
            Events: ['s3:ObjectCreated:*'],
            Filter: {
              Key: {
                FilterRules: [
                  { Name: 'prefix', Value: 'sparient-remediation-responses/' },
                  { Name: 'suffix', Value: '.json' },
                ],
              },
            },
          }],
        },
      }));
      console.log('  S3 notification configured ✓\n');
    } catch (err: any) {
      console.error('  S3 notification config failed:', err?.message ?? err);
      console.error('  (Set SQS_RESPONSES_QUEUE_ARN env var and check bucket permissions)\n');
    }
  } else {
    console.log('  SQS_RESPONSES_QUEUE_ARN not set — skipping notification config\n');
  }

  // ── Quick reference ────────────────────────────────────────────────────────

  console.log('Copy into your Postman collection variable:');
  console.log(`  institutionId: ${institution.id}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
