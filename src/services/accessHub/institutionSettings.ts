/**
 * Institution account remediation settings (TASK-11 / VALIDATION-11).
 * Tech §4.8, §2; Functional §3.3.4.
 *
 * ## Mode ↔ writebackOptIn mapping (§2)
 *
 * | API mode  | Institution.writebackOptIn |
 * |-----------|---------------------------|
 * | opt_in    | false                     |
 * | opt_out   | true                      |
 *
 * Invariant: mode === "opt_out" iff writeback_opt_in === true
 */

import { z } from 'zod';
import type { Institution } from '@prisma/client';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';

// ─── Response type ────────────────────────────────────────────────────────────

export type InstitutionSettingsData = {
  institution_id: string;
  remediation_delivery: {
    mode: 'opt_in' | 'opt_out';
    writeback_opt_in: boolean;
  };
};

// ─── Body schema ──────────────────────────────────────────────────────────────

export const patchInstitutionSettingsBodySchema = z.object({
  remediation_delivery: z.object({
    mode: z.enum(['opt_in', 'opt_out'], {
      required_error: 'remediation_delivery.mode is required',
      invalid_type_error: 'remediation_delivery.mode must be "opt_in" or "opt_out"',
    }),
  }),
});

export type PatchInstitutionSettingsBody = z.infer<
  typeof patchInstitutionSettingsBodySchema
>;

export function parsePatchInstitutionSettingsBody(
  raw: unknown,
): PatchInstitutionSettingsBody {
  const result = patchInstitutionSettingsBodySchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw Errors.badRequest(msg);
  }
  return result.data;
}

// ─── Pure builder ─────────────────────────────────────────────────────────────

export function buildInstitutionSettingsData(
  institution: Pick<Institution, 'id' | 'writebackOptIn'>,
): InstitutionSettingsData {
  const writebackOptIn = institution.writebackOptIn;
  return {
    institution_id: institution.id,
    remediation_delivery: {
      mode: writebackOptIn ? 'opt_out' : 'opt_in',
      writeback_opt_in: writebackOptIn,
    },
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function getInstitutionSettings(
  institution: Institution,
): Promise<InstitutionSettingsData> {
  return buildInstitutionSettingsData(institution);
}

export async function patchInstitutionSettings(
  institution: Institution,
  body: PatchInstitutionSettingsBody,
): Promise<InstitutionSettingsData> {
  const newWritebackOptIn = body.remediation_delivery.mode === 'opt_out';

  const updated = await prisma.institution.update({
    where: { id: institution.id },
    data: { writebackOptIn: newWritebackOptIn },
  });

  return buildInstitutionSettingsData(updated);
}
