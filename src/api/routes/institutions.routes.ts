import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { syncConfigSchema, syncConfigPatchSchema } from '../../services/sync/syncConfig';
import { provisionInstitutionBucket } from '../../services/storage/InstitutionBucketService';

const router = Router();

// Body schema for POST /institutions. Canvas-only for now — sourceType is a
// literal rather than the full SourceType enum so a sharepoint payload 400s with
// a clear message instead of creating an un-syncable row. credentials shape
// matches what CanvasSourceClient reads (domain without scheme, account_id, api_token).
const createInstitutionSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric/hyphens'),
  sourceType: z.literal('canvas'),
  credentials: z.object({
    domain: z.string().min(1),
    account_id: z.string().min(1),
    api_token: z.string().min(1),
  }),
  // Optional knobs — same editable fields as PATCH; omit to take schema defaults.
  writebackOptIn: z.boolean().optional(),
  syncEnabled: z.boolean().optional(),
  syncTime: z.string().regex(/^\d{2}:\d{2}$/, 'syncTime must be HH:MM').optional(),
  syncConfig: syncConfigSchema.optional(),
});

// Columns returned to callers. Deliberately excludes `credentials` (Canvas API
// token) — see the same rule on the PATCH/update select below.
const PUBLIC_INSTITUTION_SELECT = {
  id: true,
  name: true,
  slug: true,
  sourceType: true,
  writebackOptIn: true,
  s3Bucket: true,
  syncEnabled: true,
  syncTime: true,
  syncConfig: true,
  lastSyncedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// POST /institutions
// Register a new institution and provision its S3 bucket (sparient-<id>, in the
// Lambda's region) wired to the responses queue — after this the tick scheduler
// can sync it with no further setup.
//
// NOTE: unauthenticated for now. Auth is the top priority follow-up (docs/TODO.md)
// — this endpoint stores credentials and creates AWS resources and MUST NOT ship
// to a publicly-reachable prod long-term.
//
// Two-phase (DB row, then AWS): not a single transaction. If provisioning fails
// we delete the just-created row so a retry starts clean and no half-onboarded
// institution lingers. provisionInstitutionBucket is idempotent, so a retry after
// a partial failure (bucket made, notification not) still succeeds.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createInstitutionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw Errors.badRequest(
        parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; '),
      );
    }
    const data = parsed.data;

    let institution;
    try {
      institution = await prisma.institution.create({
        data: {
          name: data.name,
          slug: data.slug,
          sourceType: data.sourceType,
          credentials: data.credentials,
          ...(data.writebackOptIn !== undefined && { writebackOptIn: data.writebackOptIn }),
          ...(data.syncEnabled !== undefined && { syncEnabled: data.syncEnabled }),
          ...(data.syncTime !== undefined && { syncTime: data.syncTime }),
          ...(data.syncConfig !== undefined && { syncConfig: data.syncConfig }),
        },
        select: PUBLIC_INSTITUTION_SELECT,
      });
    } catch (err) {
      // Unique-constraint on slug → 409 instead of a generic 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict(`Institution with slug '${data.slug}' already exists`);
      }
      throw err;
    }

    // Provision the bucket + response notification. On failure, roll back the row.
    try {
      const bucketName = await provisionInstitutionBucket(institution.id);
      logger.info('Institution registered', { institutionId: institution.id, bucketName });
    } catch (err) {
      await prisma.institution
        .delete({ where: { id: institution.id } })
        .catch((delErr) =>
          logger.error('Failed to roll back institution after provisioning error', {
            institutionId: institution!.id,
            error: delErr instanceof Error ? delErr.message : String(delErr),
          }),
        );
      logger.error('Institution bucket provisioning failed; rolled back row', {
        institutionId: institution.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw Errors.badGateway('Failed to provision institution storage; please retry');
    }

    res.status(201).json({ success: true, data: institution });
  } catch (err) {
    next(err);
  }
});

// Body schema for PATCH /institutions/:id. Every top-level field optional —
// only provided columns are written. For syncConfig:
//   - omit:  column unchanged
//   - null:  reset to all defaults (write SQL NULL)
//   - object: merged into existing config (caller can send any subset)
// Unknown enum values inside syncConfig still 400 via syncConfigPatchSchema.
const updateInstitutionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  syncEnabled: z.boolean().optional(),
  syncTime: z.string().regex(/^\d{2}:\d{2}$/, 'syncTime must be HH:MM').optional(),
  writebackOptIn: z.boolean().optional(),
  syncConfig: syncConfigPatchSchema.nullable().optional(),
});

// PATCH /institutions/:institutionId
// Update editable institution fields. All body fields are optional; only the
// provided ones are written. syncConfig is strictly validated against the
// Zod schema — typos in enum values (file types, course states) return 400.
router.patch(
  '/:institutionId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;

      const parsed = updateInstitutionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest(
          parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; '),
        );
      }

      const data = parsed.data;
      if (Object.keys(data).length === 0) {
        throw Errors.badRequest('At least one field must be provided');
      }

      // Surface a clean 404 instead of Prisma's RecordNotFound at update time.
      // Also fetch current syncConfig — needed below to merge a partial update.
      const existing = await prisma.institution.findUnique({
        where: { id: institutionId },
        select: { id: true, syncConfig: true },
      });
      if (!existing) throw Errors.notFound('Institution');

      const updateData: Prisma.InstitutionUpdateInput = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.syncEnabled !== undefined) updateData.syncEnabled = data.syncEnabled;
      if (data.syncTime !== undefined) updateData.syncTime = data.syncTime;
      if (data.writebackOptIn !== undefined) updateData.writebackOptIn = data.writebackOptIn;

      if (data.syncConfig === null) {
        // Explicit reset → write SQL NULL. getEffectiveSyncConfig will resolve
        // to all defaults on subsequent reads.
        updateData.syncConfig = Prisma.DbNull;
      } else if (data.syncConfig !== undefined) {
        // Strict-parse the existing stored config (with defaults filling in
        // missing fields). If it's malformed, refuse the PATCH with a clear
        // recovery instruction — silent salvage would hide the underlying
        // problem. Bad data here is rare (only manual DB edits or schema
        // evolution) and the operator should fix it explicitly.
        const existingRaw =
          existing.syncConfig == null ||
          typeof existing.syncConfig !== 'object' ||
          Array.isArray(existing.syncConfig)
            ? {}
            : (existing.syncConfig as Record<string, unknown>);
        const existingResult = syncConfigSchema.safeParse(existingRaw);
        if (!existingResult.success) {
          throw Errors.badRequest(
            'Existing syncConfig has invalid values; PATCH { "syncConfig": null } first to reset, then re-apply your changes. ' +
              `Issues: ${existingResult.error.issues
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; ')}`,
          );
        }

        // Overlay only the patch keys the caller actually sent. (Zod's strip
        // mode means data.syncConfig has only schema-known keys; the
        // undefined filter is belt-and-suspenders.)
        const patchEntries = Object.entries(data.syncConfig).filter(([, v]) => v !== undefined);
        const merged = { ...existingResult.data, ...Object.fromEntries(patchEntries) };

        // Re-validate the merged result. Should always pass since both
        // sides are pre-validated, but defensive against future schema drift.
        const validated = syncConfigSchema.safeParse(merged);
        if (!validated.success) {
          throw Errors.badRequest(
            `Merged syncConfig failed validation: ${validated.error.issues
              .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
              .join('; ')}`,
          );
        }
        updateData.syncConfig = validated.data;
      }

      // Explicit select — we never want to leak `credentials` (which holds
      // the Canvas API token) in any HTTP response. Mirror this in any future
      // GET /institutions endpoint.
      const updated = await prisma.institution.update({
        where: { id: institutionId },
        data: updateData,
        select: {
          id: true,
          name: true,
          slug: true,
          sourceType: true,
          writebackOptIn: true,
          s3Bucket: true,
          syncEnabled: true,
          syncTime: true,
          syncConfig: true,
          lastSyncedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      logger.info('Institution updated', {
        institutionId,
        fields: Object.keys(data),
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /institutions/:institutionId/data
// Wipes all course/file/batch data for an institution, leaving the institution row intact.
// Useful for resetting a dev/test environment or forcing a clean re-sync.
router.delete(
  '/:institutionId/data',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { institutionId } = req.params;

      const institution = await prisma.institution.findUnique({
        where: { id: institutionId },
      });

      if (!institution) throw Errors.notFound('Institution');

      const result = await prisma.$transaction(async (tx) => {
        // Delete in FK-safe order: leaf tables first, then parents
        const { count: issueCategories } = await tx.fileIssueCategory.deleteMany({
          where: { batchFile: { batch: { institutionId } } },
        });

        const { count: batchFiles } = await tx.batchFile.deleteMany({
          where: { batch: { institutionId } },
        });

        const { count: batches } = await tx.batch.deleteMany({
          where: { institutionId },
        });

        const { count: sourceFiles } = await tx.sourceFile.deleteMany({
          where: { course: { institutionId } },
        });

        const { count: courses } = await tx.course.deleteMany({
          where: { institutionId },
        });

        return { issueCategories, batchFiles, batches, sourceFiles, courses };
      });

      logger.info('Institution data wiped', { institutionId, ...result });

      res.json({ success: true, institutionId, deleted: result });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
