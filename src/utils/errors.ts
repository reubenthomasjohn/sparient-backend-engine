export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export const Errors = {
  notFound: (resource: string) =>
    new AppError(`${resource} not found`, 404, 'NOT_FOUND'),

  badRequest: (message: string) =>
    new AppError(message, 400, 'BAD_REQUEST'),

  conflict: (message: string) =>
    new AppError(message, 409, 'CONFLICT'),

  badGateway: (message: string) =>
    new AppError(message, 502, 'BAD_GATEWAY'),

  internal: (message = 'Internal server error') =>
    new AppError(message, 500, 'INTERNAL_ERROR'),
};
