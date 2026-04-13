import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

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

  // Derive a URL-safe slug from the domain, e.g. "myuni.instructure.com" → "myuni"
  const slug = canvasDomain.split('.')[0];

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
      syncEnabled:    true,
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

  // ── Connectivo API Key ─────────────────────────────────────────────────────

  const connectivoSecret = process.env.CONNECTIVO_API_KEY_SECRET;

  let plaintextKey: string;
  let keySource: string;

  if (connectivoSecret) {
    // Use the value from .env so it stays consistent across re-seeds
    plaintextKey = connectivoSecret;
    keySource = 'from CONNECTIVO_API_KEY_SECRET in .env';
  } else {
    // Generate a fresh key — only happens if the env var isn't set
    plaintextKey = randomBytes(32).toString('hex');
    keySource = 'randomly generated (not in .env — save this now)';
  }

  const keyHash = hashKey(plaintextKey);

  await prisma.connectivoApiKey.upsert({
    where: { keyHash },
    create: {
      name:    'Connectivo',
      keyHash,
      isActive: true,
    },
    update: {
      isActive: true,
    },
  });

  console.log('Connectivo API Key');
  console.log(`  Source:   ${keySource}`);
  console.log(`  Key:      ${plaintextKey}`);
  console.log('  (Give this key to Connectivo — it is never stored in plaintext)\n');

  // ── Quick-reference ────────────────────────────────────────────────────────

  console.log('Copy these into your Postman collection variables:');
  console.log(`  institutionId:    ${institution.id}`);
  console.log(`  connectivoApiKey: ${plaintextKey}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
