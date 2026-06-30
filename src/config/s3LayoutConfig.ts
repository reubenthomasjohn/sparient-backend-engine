import { z } from 'zod';
import type { Institution } from '@prisma/client';
import { S3_PREFIX } from './s3Prefixes';
import { logger } from '../utils/logger';

export const s3LayoutConfigSchema = z.object({
  sourcePrefix: z.string().min(1).default(S3_PREFIX.SOURCE),
  remediatedPrefix: z.string().min(1).default(S3_PREFIX.REMEDIATED),
  requestsPrefix: z.string().min(1).default(S3_PREFIX.REQUESTS),
  responsesPrefix: z.string().min(1).default(S3_PREFIX.RESPONSES),
});

export type S3LayoutConfig = z.infer<typeof s3LayoutConfigSchema>;

export const s3LayoutConfigPatchSchema = z.object({
  sourcePrefix: z.string().min(1).optional(),
  remediatedPrefix: z.string().min(1).optional(),
  requestsPrefix: z.string().min(1).optional(),
  responsesPrefix: z.string().min(1).optional(),
});

export type S3LayoutConfigPatch = z.infer<typeof s3LayoutConfigPatchSchema>;

export function getDefaultS3LayoutConfig(): S3LayoutConfig {
  return s3LayoutConfigSchema.parse({});
}

function coerceToObject(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function getEffectiveS3LayoutConfig(
  institution: Pick<Institution, 'id' | 's3LayoutConfig'>,
): S3LayoutConfig {
  const raw = coerceToObject(institution.s3LayoutConfig);
  const result = s3LayoutConfigSchema.safeParse(raw);

  if (result.success) {
    return result.data;
  }

  logger.error('s3LayoutConfig: parse failed, falling back to all defaults', {
    institutionId: institution.id,
    errors: result.error.issues.map((i) => ({
      path: i.path.join('.') || '<root>',
      message: i.message,
    })),
  });
  return getDefaultS3LayoutConfig();
}

/** Resolve the exact S3 object key for a Connectivo response JSON. */
export function resolveResponseObjectKey(key: string, responsesPrefix: string): string {
  const prefixWithSlash = `${responsesPrefix}/`;
  if (key.startsWith(prefixWithSlash)) return key;
  return `${prefixWithSlash}${key}`;
}
