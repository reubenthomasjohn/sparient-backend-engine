import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Attaches { id, institutionId } to res.locals.connectivoApiKey. institutionId is null
// for legacy global keys and a string for scoped keys — routes consult it to block
// cross-institution access.
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

  res.locals.connectivoApiKey = {
    id: apiKey.id,
    institutionId: apiKey.institutionId,
  };

  prisma.connectivoApiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  next();
}

export function getAuthInstitutionId(res: Response): string | null {
  return res.locals.connectivoApiKey?.institutionId ?? null;
}
