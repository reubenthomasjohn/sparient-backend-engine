import type { Course, Institution } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';

/**
 * Access Hub tenant policy (TASK-02 / tech §5.1 / VALIDATION-02):
 * - Invalid `institution_id` format → 400 BAD_REQUEST.
 * - Unknown institution, or no course for (institution_id, canvas_course_id) → 404 NOT_FOUND
 *   with generic message (no distinction in the client response — avoids cross-tenant leaks).
 * - Course lookup is always by composite (institutionId + canvasCourseId), so a course
 *   “belonging to another institution” is indistinguishable from “missing” → same 404.
 */

export function parseAccessHubInstitutionId(raw: string): string {
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) {
    throw Errors.badRequest('Invalid institution_id');
  }
  return parsed.data;
}

export async function assertInstitution(
  institutionIdFromPath: string,
): Promise<Institution> {
  const id = parseAccessHubInstitutionId(institutionIdFromPath);
  const institution = await prisma.institution.findUnique({ where: { id } });
  if (!institution) {
    throw Errors.accessHubScopeNotFound();
  }
  return institution;
}

export async function getCourseForInstitution(
  institutionId: string,
  canvasCourseId: string,
): Promise<Course> {
  const course = await prisma.course.findUnique({
    where: {
      institutionId_canvasCourseId: {
        institutionId,
        canvasCourseId,
      },
    },
  });
  if (!course) {
    throw Errors.accessHubScopeNotFound();
  }
  return course;
}
