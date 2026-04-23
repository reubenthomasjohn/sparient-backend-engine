import { Request, Response, NextFunction } from 'express';
import { assertInstitution, getCourseForInstitution } from '../../services/accessHub/tenantScope';
import { Errors } from '../../utils/errors';

export async function accessHubAssertInstitution(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = req.params.institution_id;
    if (!raw) {
      next(Errors.badRequest('institution_id is required'));
      return;
    }
    const institution = await assertInstitution(raw);
    req.accessHubInstitution = institution;
    next();
  } catch (err) {
    next(err);
  }
}

export async function accessHubAssertCourse(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const institution = req.accessHubInstitution;
    if (!institution) {
      next(Errors.internal('Institution scope was not loaded'));
      return;
    }
    const rawCourse = req.params.canvas_course_id;
    const canvasCourseId = rawCourse?.trim();
    if (!canvasCourseId) {
      next(Errors.badRequest('canvas_course_id is required'));
      return;
    }
    const course = await getCourseForInstitution(institution.id, canvasCourseId);
    req.accessHubCourse = course;
    next();
  } catch (err) {
    next(err);
  }
}
