import { Router, type Request, type Response, type NextFunction } from 'express';
import { accessHubAuth } from '../middleware/accessHubSignedAuth.middleware';
import {
  accessHubAssertCourse,
  accessHubAssertInstitution,
} from '../middleware/accessHubScope.middleware';
import { sendAccessHubSuccess } from '../../utils/accessHubResponse';
import { getCourseDashboardForCourse } from '../../services/accessHub/courseDashboard';
import {
  getCourseFileList,
  parseFileListQuery,
} from '../../services/accessHub/courseFilesList';
import {
  getCourseSettings,
  patchCourseSettings,
  parsePatchSettingsBody,
} from '../../services/accessHub/courseRemediationSettings';
import {
  triggerFileReplace,
  parseReplaceBody,
} from '../../services/accessHub/courseFileReplace';
import { getInstitutionDashboard } from '../../services/accessHub/institutionDashboard';
import {
  getScannedCoursesList,
  parseScannedCoursesQuery,
} from '../../services/accessHub/adminScannedCourses';
import {
  getAdminCourseFileList,
  parseAdminFilesQuery,
} from '../../services/accessHub/adminCourseFiles';
import {
  getInstitutionSettings,
  patchInstitutionSettings,
  parsePatchInstitutionSettingsBody,
} from '../../services/accessHub/institutionSettings';

const router = Router();

// Combined auth: tries signed (HMAC-SHA256) first if X-Signature present, falls back to Basic.
router.use(accessHubAuth);

/** Contract probe for TASK-01; real handlers land in later tasks. */
router.get('/ping', (_req, res) => {
  sendAccessHubSuccess(res, { pong: true });
});

/** TASK-02 scope probes; replace with real resources in later tasks. */
const institutionScoped = Router({ mergeParams: true });
institutionScoped.use(accessHubAssertInstitution);
institutionScoped.get('/scope', (req, res) => {
  const inst = req.accessHubInstitution!;
  sendAccessHubSuccess(res, { institution_id: inst.id });
});

institutionScoped.get(
  '/dashboard',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inst = req.accessHubInstitution!;
      const canvasTermId =
        typeof req.query.canvas_term_id === 'string' && req.query.canvas_term_id.trim()
          ? req.query.canvas_term_id.trim()
          : undefined;
      const data = await getInstitutionDashboard(inst.id, canvasTermId);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

institutionScoped.get(
  '/settings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inst = req.accessHubInstitution!;
      const data = await getInstitutionSettings(inst);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

institutionScoped.patch(
  '/settings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inst = req.accessHubInstitution!;
      const body = parsePatchInstitutionSettingsBody(req.body);
      const data = await patchInstitutionSettings(inst, body);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

institutionScoped.get(
  '/files',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inst = req.accessHubInstitution!;
      const query = parseAdminFilesQuery(req.query as Record<string, unknown>);
      const data = await getAdminCourseFileList(inst, query);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

institutionScoped.get(
  '/courses',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inst = req.accessHubInstitution!;
      const query = parseScannedCoursesQuery(req.query as Record<string, unknown>);
      const data = await getScannedCoursesList(inst, query);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

const courseScoped = Router({ mergeParams: true });
courseScoped.use(accessHubAssertInstitution);
courseScoped.use(accessHubAssertCourse);
courseScoped.get('/scope', (req, res) => {
  const inst = req.accessHubInstitution!;
  const course = req.accessHubCourse!;
  sendAccessHubSuccess(res, {
    institution_id: inst.id,
    course_id: course.id,
    canvas_course_id: course.canvasCourseId,
  });
});

courseScoped.get(
  '/dashboard',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const course = req.accessHubCourse!;
      const data = await getCourseDashboardForCourse(course);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

courseScoped.get(
  '/files',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const course = req.accessHubCourse!;
      const institution = req.accessHubInstitution!;
      const query = parseFileListQuery(req.query as Record<string, unknown>);
      const data = await getCourseFileList(course, institution, query);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

courseScoped.get(
  '/settings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const course = req.accessHubCourse!;
      const institution = req.accessHubInstitution!;
      const data = await getCourseSettings(course, institution);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

courseScoped.patch(
  '/settings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const course = req.accessHubCourse!;
      const institution = req.accessHubInstitution!;
      const body = parsePatchSettingsBody(req.body);
      const data = await patchCourseSettings(course, institution, body);
      sendAccessHubSuccess(res, data);
    } catch (err) {
      next(err);
    }
  },
);

// File-level sub-router so canvas_file_id is accessible via mergeParams.
const fileScoped = Router({ mergeParams: true });
fileScoped.use(accessHubAssertInstitution);
fileScoped.use(accessHubAssertCourse);

fileScoped.post(
  '/replace',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const course = req.accessHubCourse!;
      const canvasFileId = req.params.canvas_file_id!;
      const body = parseReplaceBody(req.body);
      const data = await triggerFileReplace(course, canvasFileId, body);
      res.status(202).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

// More specific path first — otherwise `/institutions/:id` eats `/institutions/:id/courses/...`.
// Most-specific first: file-level routes before course-level, course before institution.
router.use(
  '/institutions/:institution_id/courses/:canvas_course_id/files/:canvas_file_id',
  fileScoped,
);
router.use(
  '/institutions/:institution_id/courses/:canvas_course_id',
  courseScoped,
);
router.use('/institutions/:institution_id', institutionScoped);

export default router;
