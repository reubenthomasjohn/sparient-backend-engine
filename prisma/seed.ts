import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
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

  // Slug is used in S3 paths — set INSTITUTION_SLUG explicitly.
  // Falls back to the first component of the Canvas domain if not provided.
  // Must be lowercase, alphanumeric + hyphens only, and unique across institutions.
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
  console.log(`  Slug: ${institution.slug}\n`);

  // Connectivo no longer uses an API; the integration is via the request/response S3
  // buckets. Nothing to seed here. Hand Connectivo the IAM user credentials separately.

  console.log('Copy this into your Postman collection variable:');
  console.log(`  institutionId: ${institution.id}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
