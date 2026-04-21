import {
  discoverCourses,
  discoverFiles,
  uploadFile,
  batchPublish,
  DiscoverCoursesInput,
  DiscoverFilesInput,
  UploadFileInput,
  BatchPublishInput,
} from './handler';
import { logger } from '../../utils/logger';

type StepInput = DiscoverCoursesInput | DiscoverFilesInput | UploadFileInput | BatchPublishInput;

export async function handler(event: StepInput): Promise<unknown> {
  logger.info('CourseWorkflow: invoked', { step: event.step });

  switch (event.step) {
    case 'discover-courses':
      return discoverCourses(event);
    case 'discover-files':
      return discoverFiles(event);
    case 'upload-file':
      return uploadFile(event);
    case 'batch-publish':
      return batchPublish(event);
    default:
      throw new Error(`Unknown step: ${(event as { step: string }).step}`);
  }
}
