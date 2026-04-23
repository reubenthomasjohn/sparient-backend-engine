import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../../config';
import { Errors } from '../../utils/errors';

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function accessHubBasicAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) {
    next(Errors.unauthorized('Missing or invalid Basic authentication'));
    return;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    next(Errors.unauthorized('Missing or invalid Basic authentication'));
    return;
  }

  const colon = decoded.indexOf(':');
  if (colon === -1) {
    next(Errors.unauthorized('Missing or invalid Basic authentication'));
    return;
  }

  const user = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);

  if (
    !timingSafeEqualUtf8(user, config.accessHub.basicUser) ||
    !timingSafeEqualUtf8(password, config.accessHub.basicPassword)
  ) {
    next(Errors.unauthorized('Missing or invalid Basic authentication'));
    return;
  }

  next();
}
