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

  unauthorized: (message = 'Authentication required') =>
    new AppError(message, 401, 'UNAUTHORIZED'),

  /**
   * Access Hub scope: unknown institution, unknown course for path, or no row for
   * (institution_id, canvas_course_id). Generic message — TASK-02 / VALIDATION-02 (no tenant leak).
   */
  accessHubScopeNotFound: () =>
    new AppError('Resource not found', 404, 'NOT_FOUND'),

  forbidden: (message = 'Access forbidden') =>
    new AppError(message, 403, 'FORBIDDEN'),

  conflict: (message: string) =>
    new AppError(message, 409, 'CONFLICT'),

  internal: (message = 'Internal server error') =>
    new AppError(message, 500, 'INTERNAL_ERROR'),
};
