// One-time migration: encrypt any plaintext institution.credentials.api_token in place.
// Idempotent — already-encrypted tokens (prefixed "kms:") are skipped.
//
// Run AFTER `terraform apply` creates the KMS key, with the DB tunnel open and env set, e.g. prod:
//   AWS_PROFILE=sparient AWS_REGION=us-west-2 \
//   CREDENTIALS_KMS_KEY_ID=alias/sparient-prod-credentials \
//   DATABASE_URL='postgresql://sparient:<pw>@localhost:5432/sparient?sslmode=require' \
//   npx ts-node scripts/encrypt-credentials.ts
//
// Requires the runner to have kms:Encrypt on the key. The app keeps working before this
// runs — decryptToken passes plaintext tokens through until they're migrated.
import prisma from '../src/db/client';
import { encryptToken, isEncrypted } from '../src/services/crypto/credentialCrypto';

async function main(): Promise<void> {
  const institutions = await prisma.institution.findMany({ select: { id: true, slug: true, credentials: true } });
  let encrypted = 0;
  let skipped = 0;

  for (const inst of institutions) {
    const creds = inst.credentials as { api_token?: string } | null;
    if (!creds?.api_token || isEncrypted(creds.api_token)) {
      skipped++;
      continue;
    }
    const api_token = await encryptToken(creds.api_token);
    await prisma.institution.update({
      where: { id: inst.id },
      data: { credentials: { ...creds, api_token } },
    });
    encrypted++;
    console.log(`encrypted: ${inst.slug} (${inst.id})`);
  }

  console.log(`done — ${encrypted} encrypted, ${skipped} already-encrypted/skipped`);
}

main()
  .catch((err) => {
    console.error('encrypt-credentials failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
