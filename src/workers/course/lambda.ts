import {
  discoverFiles,
  uploadFile,
  batchPublish,
  DiscoverFilesInput,
  UploadFileInput,
  BatchPublishInput,
} from './handler';
import { logger } from '../../utils/logger';

// Single Lambda entry point for all 3 Step Functions steps. The state machine
// injects `step` via Parameters to route to the correct handler.
type StepInput = DiscoverFilesInput | UploadFileInput | BatchPublishInput;

export async function handler(event: StepInput): Promise<unknown> {
  logger.info('CourseWorkflow: invoked', { step: event.step });

  switch (event.step) {
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
