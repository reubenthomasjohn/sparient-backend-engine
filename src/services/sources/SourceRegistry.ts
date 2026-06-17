import { Institution, SourceType } from '@prisma/client';
import { ISourceClient } from './ISourceClient';
import { CanvasSourceClient } from './canvas/CanvasSourceClient';
import { AppError } from '../../utils/errors';
import { decryptToken } from '../crypto/credentialCrypto';

export class SourceRegistry {
  // Async because the api_token is encrypted at rest (KMS) and decrypted here, once,
  // before the client is built. The source client receives plaintext credentials and
  // stays unaware of encryption. Legacy plaintext tokens pass through unchanged.
  static async getClient(institution: Institution): Promise<ISourceClient> {
    switch (institution.sourceType) {
      case SourceType.canvas: {
        const creds = institution.credentials as {
          domain: string;
          account_id: string;
          api_token: string;
        };
        const api_token = await decryptToken(creds.api_token);
        return new CanvasSourceClient({
          ...institution,
          credentials: { ...creds, api_token },
        });
      }
      default:
        throw new AppError(
          `No client implemented for source type: ${institution.sourceType}`,
          500,
          'UNSUPPORTED_SOURCE_TYPE',
        );
    }
  }
}
