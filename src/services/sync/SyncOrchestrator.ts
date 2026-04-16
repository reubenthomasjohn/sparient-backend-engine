import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import prisma from '../../db/client';
import { discoveryQueue } from '../../queue';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const sfn = new SFNClient({ region: config.aws.region });

export class SyncOrchestrator {
  // Full institution sync — enqueues a discover message. The discovery handler lists
  // courses and starts one SFN execution per course.
  async syncInstitution(institutionId: string, force?: boolean): Promise<void> {
    await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    await discoveryQueue.send({ type: 'discover', institutionId, force });
    logger.info('SyncOrchestrator: institution discover enqueued', { institutionId, force });
  }

  // Single course sync — starts a Step Functions execution directly (skips the
  // institution-level discover since we already know which course to process).
  async syncCourse(institutionId: string, canvasCourseId: string, force?: boolean): Promise<void> {
    await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });

    if (config.aws.courseWorkflowArn) {
      await sfn.send(new StartExecutionCommand({
        stateMachineArn: config.aws.courseWorkflowArn,
        name: `${institutionId}-${canvasCourseId}-${Date.now()}`,
        input: JSON.stringify({ institutionId, canvasCourseId, force: force ?? false }),
      }));
      logger.info('SyncOrchestrator: SFN execution started', { institutionId, canvasCourseId, force });
    } else {
      // Local dev: no SFN, run inline via the course handler.
      const { discoverFiles, batchPublish } = await import('../../workers/course/handler');
      const result = await discoverFiles({
        step: 'discover-files',
        institutionId,
        canvasCourseId,
        force,
      });
      // In local dev, uploads run via in-memory queue consumer.
      // BatchPublish runs after a short delay won't help — just call it directly.
      // Files may not be uploaded yet. The next manual sync will batch them.
      await batchPublish({
        step: 'batch-publish',
        institutionId,
        canvasCourseId,
        courseId: result.courseId,
        isInitialSync: result.isInitialSync,
        uploadResults: [],
      });
    }
  }
}
