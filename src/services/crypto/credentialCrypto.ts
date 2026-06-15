import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { config } from '../../config';

// At-rest encryption for institution Canvas API tokens. The token is small (<4KB),
// so we use KMS Encrypt/Decrypt directly (no envelope). Stored form is
// `kms:<base64 ciphertext>`; the prefix lets decryptToken pass through any
// legacy plaintext token written before encryption was introduced, so the system
// keeps working during the one-time migration.

const PREFIX = 'kms:';
const kms = new KMSClient({ region: config.aws.region });

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export async function encryptToken(plaintext: string): Promise<string> {
  if (!config.credentials.kmsKeyId) {
    // Fail loud rather than silently persist plaintext.
    throw new Error('CREDENTIALS_KMS_KEY_ID is not set — refusing to store an unencrypted token');
  }
  const res = await kms.send(
    new EncryptCommand({
      KeyId: config.credentials.kmsKeyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
    }),
  );
  return PREFIX + Buffer.from(res.CiphertextBlob!).toString('base64');
}

export async function decryptToken(stored: string): Promise<string> {
  if (!isEncrypted(stored)) return stored; // legacy plaintext (pre-migration)
  const res = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(stored.slice(PREFIX.length), 'base64'),
    }),
  );
  return Buffer.from(res.Plaintext!).toString('utf8');
}
