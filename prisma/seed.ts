import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';
import { provisionInstitutionBucket } from '../src/services/storage/InstitutionBucketService';
import { getBucketName } from '../src/config/s3Bucket';

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

  const bucketName = getBucketName(institution.id, institution.s3Bucket);
  console.log(`  S3 bucket: ${bucketName}`);

  try {
    await provisionInstitutionBucket(institution.id, institution.s3Bucket);
    console.log('  S3 bucket provisioned ✓\n');
  } catch (err: any) {
    // BucketAlreadyOwnedByYou = bucket exists, which is fine on re-seed.
    if (err?.Code === 'BucketAlreadyOwnedByYou' || err?.name === 'BucketAlreadyOwnedByYou') {
      console.log('  S3 bucket already exists ✓\n');
    } else {
      console.error('  S3 bucket provisioning failed:', err?.message ?? err);
      console.error('  (You may need to create it manually or check AWS credentials)\n');
    }
  }

  // ── Quick reference ────────────────────────────────────────────────────────

  console.log('Copy into your Postman collection variable:');
  console.log(`  institutionId: ${institution.id}`);
  console.log(`  S3 bucket:     ${bucketName}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
