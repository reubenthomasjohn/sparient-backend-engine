import { z } from 'zod';
import type { Institution } from '@prisma/client';
import { logger } from '../../utils/logger';
import { ALL_FILE_TYPES, FILE_TYPE_REGISTRY, type FileType } from './fileTypes';

// Re-export so callers don't need a second import path.
export { ALL_FILE_TYPES, FILE_TYPE_REGISTRY, type FileType };

// Course states we'll accept on syncConfig. Excludes 'created' (rare draft
// state, never useful) and 'deleted' (Canvas may keep deleted-course data
// briefly but it's untrustworthy for remediation).
export const COURSE_STATES = ['available', 'unpublished', 'completed'] as const;
export type CourseState = (typeof COURSE_STATES)[number];

// Conservative default for new + null-config institutions. Anyone who wants
// the wider registry (legacy Office, OpenDocument, more images, etc.) opts in
// by PATCHing syncConfig.allowedFileTypes explicitly.
const DEFAULT_FILE_TYPES: FileType[] = ['pdf', 'docx', 'pptx', 'xlsx', 'jpg', 'png'];

// Common alternate spellings users naturally try. Normalized before Zod sees
// them so { allowedFileTypes: ["jpeg"] } is accepted instead of returning 400.
const FILE_TYPE_ALIASES: Record<string, FileType> = {
  jpeg: 'jpg',
};

// Friendly error message when a caller PATCHes a file type we don't know.
const fileTypeEnum = z.enum(ALL_FILE_TYPES, {
  errorMap: (issue, ctx) => {
    if (issue.code === 'invalid_enum_value') {
      return {
        message: `File type '${String(ctx.data)}' is not supported. Supported types: ${ALL_FILE_TYPES.join(', ')}.`,
      };
    }
    return { message: ctx.defaultError };
  },
});

// Pre-normalize input through the aliases table before the strict enum
// validates it. Non-string values pass through unchanged so the enum
// produces its standard mismatch error.
const fileTypeEnumWithAliases = z.preprocess(
  (val) => (typeof val === 'string' && val in FILE_TYPE_ALIASES ? FILE_TYPE_ALIASES[val] : val),
  fileTypeEnum,
);

// Default values are returned by callable factories so each evaluation gets a
// fresh array — no shared-reference footgun if a future consumer mutates.
const defaults = {
  excludedCanvasCourseIds: () => [] as string[],
  allowedFileTypes: () => [...DEFAULT_FILE_TYPES],
  allowedCourseStates: () => ['available' as const, 'unpublished' as const],
  maxFileSizeBytes: () => null as number | null,
  skipLockedFiles: () => false,
  skipHiddenFiles: () => false,
  // NOTE: `writebackRequiresReviewAck` is reserved for the writeback feature
  // (lives on a separate branch). Stored here so the schema is forward-compatible,
  // but no consumer reads it on this branch — setting it currently has no effect.
  writebackRequiresReviewAck: () => false,
};

// ---------------------------------------------------------------------------
// Strict schema — used at PATCH time AND read time.
// Defaults fill in missing fields. Unknown enum values fail loud (400 at
// PATCH; logged + fall-back-to-defaults at sync read time).
//
// Empty arrays for the allowlist fields ARE accepted at write time. They're
// the open-by-default sugar — at runtime, getEffectiveSyncConfig swaps an
// empty allowlist for the full default. This matches the original API
// contract and avoids the round-trip mismatch of rejecting `[]` at write
// while documenting it as "use defaults" elsewhere.
// ---------------------------------------------------------------------------
export const syncConfigSchema = z.object({
  excludedCanvasCourseIds: z.array(z.string()).default(defaults.excludedCanvasCourseIds),
  allowedFileTypes: z.array(fileTypeEnumWithAliases).default(defaults.allowedFileTypes),
  allowedCourseStates: z.array(z.enum(COURSE_STATES)).default(defaults.allowedCourseStates),
  maxFileSizeBytes: z.number().int().positive().nullable().default(defaults.maxFileSizeBytes),
  skipLockedFiles: z.boolean().default(defaults.skipLockedFiles),
  skipHiddenFiles: z.boolean().default(defaults.skipHiddenFiles),
  writebackRequiresReviewAck: z.boolean().default(defaults.writebackRequiresReviewAck),
});

export type SyncConfig = z.infer<typeof syncConfigSchema>;

// ---------------------------------------------------------------------------
// Patch schema — every field optional, NO defaults. Used at PATCH time so a
// partial update doesn't silently reset fields the caller didn't send.
// Unknown enum values still fail loud.
// ---------------------------------------------------------------------------
export const syncConfigPatchSchema = z.object({
  excludedCanvasCourseIds: z.array(z.string()).optional(),
  allowedFileTypes: z.array(fileTypeEnumWithAliases).optional(),
  allowedCourseStates: z.array(z.enum(COURSE_STATES)).optional(),
  maxFileSizeBytes: z.number().int().positive().nullable().optional(),
  skipLockedFiles: z.boolean().optional(),
  skipHiddenFiles: z.boolean().optional(),
  writebackRequiresReviewAck: z.boolean().optional(),
});

export type SyncConfigPatch = z.infer<typeof syncConfigPatchSchema>;

// ---------------------------------------------------------------------------
// Effective config for hot paths. Pre-computes the Set/Maps that filter loops
// reach for repeatedly. Built once per CanvasSourceClient.
// ---------------------------------------------------------------------------
export interface EffectiveSyncConfig extends SyncConfig {
  excludedCourseIdSet: Set<string>;
  allowedMimeTypes: string[];
  allowedExtensions: Set<string>;
}

// Coerce non-objects (null, scalars, arrays) to {} so z.object() can apply
// its per-field defaults rather than throwing. Without this, a stored scalar
// (from a manual DB edit) would crash the sync at the object-level parse.
function coerceToObject(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function getEffectiveSyncConfig(
  institution: Pick<Institution, 'id' | 'syncConfig'>,
): EffectiveSyncConfig {
  const raw = coerceToObject(institution.syncConfig);
  const result = syncConfigSchema.safeParse(raw);

  // If the stored blob has any invalid value (unknown enum, wrong type,
  // negative size cap, etc.), log loud and fall back to all defaults. The
  // sync continues; the operator can investigate via the logged issues
  // and reset the config via PATCH { syncConfig: null }.
  let config: SyncConfig;
  if (result.success) {
    config = result.data;
  } else {
    logger.error('syncConfig: parse failed, falling back to all defaults', {
      institutionId: institution.id,
      errors: result.error.issues.map((i) => ({
        path: i.path.join('.') || '<root>',
        message: i.message,
      })),
    });
    config = syncConfigSchema.parse({});
  }

  // Open-by-default: explicit empty arrays for the *allowlist* fields are
  // sugar for "include everything we support". This matches the documented
  // API contract — `[]` at write time is equivalent to `null`.
  const allowedFileTypes =
    config.allowedFileTypes.length > 0 ? config.allowedFileTypes : defaults.allowedFileTypes();
  const allowedCourseStates =
    config.allowedCourseStates.length > 0
      ? config.allowedCourseStates
      : defaults.allowedCourseStates();

  // Log the resolved config once per client instance. Ops use this to
  // confirm "what filters is the engine applying right now" without
  // querying the DB or replaying the JSON blob.
  logger.info('syncConfig: resolved', {
    institutionId: institution.id,
    excludedCanvasCourseIds: config.excludedCanvasCourseIds,
    allowedFileTypes,
    allowedCourseStates,
    maxFileSizeBytes: config.maxFileSizeBytes,
    skipLockedFiles: config.skipLockedFiles,
    skipHiddenFiles: config.skipHiddenFiles,
    writebackRequiresReviewAck: config.writebackRequiresReviewAck,
  });

  return {
    ...config,
    allowedFileTypes,
    allowedCourseStates,
    excludedCourseIdSet: new Set(config.excludedCanvasCourseIds),
    allowedMimeTypes: allowedFileTypes.flatMap((t) => FILE_TYPE_REGISTRY[t].mime),
    allowedExtensions: new Set(allowedFileTypes.flatMap((t) => FILE_TYPE_REGISTRY[t].extensions)),
  };
}
