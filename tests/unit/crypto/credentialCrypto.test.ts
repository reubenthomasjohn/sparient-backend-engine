import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: vi.fn(() => ({ send })),
  EncryptCommand: vi.fn((input) => ({ kind: 'Encrypt', input })),
  DecryptCommand: vi.fn((input) => ({ kind: 'Decrypt', input })),
}));
vi.mock('../../../src/config', () => ({
  config: { aws: { region: 'us-east-2' }, credentials: { kmsKeyId: 'test-key' } },
}));

import { encryptToken, decryptToken, isEncrypted } from '../../../src/services/crypto/credentialCrypto';

beforeEach(() => send.mockReset());

describe('credentialCrypto', () => {
  it('isEncrypted detects the kms: prefix', () => {
    expect(isEncrypted('kms:abc')).toBe(true);
    expect(isEncrypted('plain-token')).toBe(false);
  });

  it('encryptToken returns kms:<base64> and calls KMS with the key id', async () => {
    send.mockResolvedValue({ CiphertextBlob: Buffer.from('cipher') });
    const out = await encryptToken('secret');
    expect(out).toBe('kms:' + Buffer.from('cipher').toString('base64'));
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as any).input.KeyId).toBe('test-key');
  });

  it('decryptToken passes legacy plaintext through WITHOUT calling KMS', async () => {
    const out = await decryptToken('plain-token');
    expect(out).toBe('plain-token');
    expect(send).not.toHaveBeenCalled();
  });

  it('decryptToken decrypts a kms:-prefixed value', async () => {
    send.mockResolvedValue({ Plaintext: Buffer.from('secret') });
    const stored = 'kms:' + Buffer.from('cipher').toString('base64');
    expect(await decryptToken(stored)).toBe('secret');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('credentialCrypto without a configured key', () => {
  it('encryptToken throws (refuses to store plaintext)', async () => {
    vi.resetModules();
    vi.doMock('../../../src/config', () => ({
      config: { aws: { region: 'us-east-2' }, credentials: { kmsKeyId: undefined } },
    }));
    const { encryptToken: enc } = await import('../../../src/services/crypto/credentialCrypto');
    await expect(enc('secret')).rejects.toThrow(/CREDENTIALS_KMS_KEY_ID/);
  });
});
