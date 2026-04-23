/**
 * Course remediation settings service (TASK-06 / VALIDATION-06).
 * Tech §4.3 / §2; Functional §3.1.2.
 *
 * ## Mode ↔ writebackOptIn mapping (§2)
 *
 * | UI mode   | Course.writebackOptIn |
 * |-----------|----------------------|
 * | opt_in    | false                |
 * | opt_out   | true                 |
 *
 * effective_writeback_opt_in = Course.writebackOptIn ?? Institution.writebackOptIn
 * mode = effective_writeback_opt_in ? "opt_out" : "opt_in"
 */

import { z } from 'zod';
import type { Course, Institution } from '@prisma/client';
import prisma from '../../db/client';
import { effectiveWritebackOptIn } from './domainDerivations';
import { Errors } from '../../utils/errors';

export type RemediationDelivery = {
  mode: 'opt_in' | 'opt_out';
  effective_writeback_opt_in: boolean;
  course_writeback_opt_in: boolean | null;
  institution_writeback_opt_in: boolean;
};

export type CourseSettingsData = {
  canvas_course_id: string;
  remediation_delivery: RemediationDelivery;
};

export const patchSettingsBodySchema = z.object({
  remediation_delivery: z.object({
    mode: z.enum(['opt_in', 'opt_out'], {
      required_error: 'remediation_delivery.mode is required',
      invalid_type_error: 'remediation_delivery.mode must be "opt_in" or "opt_out"',
    }),
  }),
});

export type PatchSettingsBody = z.infer<typeof patchSettingsBodySchema>;

export function parsePatchSettingsBody(raw: unknown): PatchSettingsBody {
  const result = patchSettingsBodySchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw Errors.badRequest(msg);
  }
  return result.data;
}

export function buildSettingsData(
  course: Pick<Course, 'canvasCourseId' | 'writebackOptIn'>,
  institution: Pick<Institution, 'writebackOptIn'>,
): CourseSettingsData {
  const effectiveWriteback = effectiveWritebackOptIn({
    institutionWritebackOptIn: institution.writebackOptIn,
    courseWritebackOptIn: course.writebackOptIn,
  });

  return {
    canvas_course_id: course.canvasCourseId,
    remediation_delivery: {
      mode: effectiveWriteback ? 'opt_out' : 'opt_in',
      effective_writeback_opt_in: effectiveWriteback,
      course_writeback_opt_in: course.writebackOptIn,
      institution_writeback_opt_in: institution.writebackOptIn,
    },
  };
}

export async function getCourseSettings(
  course: Course,
  institution: Institution,
): Promise<CourseSettingsData> {
  return buildSettingsData(course, institution);
}

export async function patchCourseSettings(
  course: Course,
  institution: Institution,
  body: PatchSettingsBody,
): Promise<CourseSettingsData> {
  const newWritebackOptIn = body.remediation_delivery.mode === 'opt_out';

  const updated = await prisma.course.update({
    where: { id: course.id },
    data: { writebackOptIn: newWritebackOptIn },
  });

  return buildSettingsData(updated, institution);
}
