import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

function isMalformedJsonBodyError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) {
    return false;
  }
  const e = err as SyntaxError & {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  return (
    e.status === 400 ||
    e.statusCode === 400 ||
    e.type === 'entity.parse.failed'
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.statusCode === 401 && err.code === 'UNAUTHORIZED') {
      res.setHeader('WWW-Authenticate', 'Basic realm="Access Hub"');
    }
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }

  if (isMalformedJsonBodyError(err)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON body',
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: err.flatten().fieldErrors,
      },
    });
    return;
  }

  // Prisma not-found errors
  if (err instanceof Error && err.name === 'NotFoundError') {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: err.message },
    });
    return;
  }

  logger.error('Unhandled error', { error: err, path: req.path, method: req.method });

  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}
