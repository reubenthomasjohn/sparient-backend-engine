import { Response } from 'express';

/** Success envelope for `/api/v1/access-hub/**` (tech §1.3). Do not add §0.1-forbidden fields to `data`. */
export function accessHubJsonSuccess<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function sendAccessHubSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
): void {
  res.status(statusCode).json(accessHubJsonSuccess(data));
}
