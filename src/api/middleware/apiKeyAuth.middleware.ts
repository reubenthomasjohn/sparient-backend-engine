import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';

// We hash the incoming key with SHA-256 and compare it against stored hashes.
// Keys are never stored in plaintext.
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['x-api-key'];

  if (!key || typeof key !== 'string') {
    next(Errors.unauthorized());
    return;
  }

  const keyHash = hashKey(key);

  const apiKey = await prisma.connectivoApiKey.findFirst({
    where: {
      keyHash,
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  if (!apiKey) {
    next(Errors.unauthorized());
    return;
  }

  // Fire-and-forget last_used_at update — no need to await
  prisma.connectivoApiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  next();
}
