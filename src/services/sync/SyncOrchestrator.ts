import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import prisma from '../../db/client';
import { discoveryQueue } from '../../queue';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const sfn = new SFNClient({ region: config.aws.region });

export class SyncOrchestrator {
  // Full institution sync — enqueues a discover message. The discovery handler
  // starts one SFN execution for the entire institution.
  async syncInstitution(institutionId: string, force?: boolean): Promise<void> {
    await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    await discoveryQueue.send({ type: 'discover', institutionId, force });
    logger.info('SyncOrchestrator: institution discover enqueued', { institutionId, force });
  }

  // Single course sync — starts an SFN execution directly, passing a pre-filtered
  // course list so only that course is processed.
  async syncCourse(institutionId: string, canvasCourseId: string, force?: boolean): Promise<void> {
    await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });

    if (!config.aws.courseWorkflowArn) {
      // Local dev fallback — run inline
      const { discoverFiles, batchPublish } = await import('../../workers/course/handler');
      const course = await prisma.course.findFirst({
        where: { institutionId, canvasCourseId },
      });
      const result = await discoverFiles({
        step: 'discover-files',
        institutionId,
        canvasCourseId,
        courseId: course?.id ?? '',
        force,
      });
      if (result.hasWork) {
        await batchPublish({
          step: 'batch-publish',
          institutionId,
          canvasCourseId,
          courseId: result.courseId,
          isInitialSync: result.isInitialSync,
          force,
        });
      }
      return;
    }

    await sfn.send(new StartExecutionCommand({
      stateMachineArn: config.aws.courseWorkflowArn,
      name: `${institutionId}-${canvasCourseId}-${Date.now()}`,
      input: JSON.stringify({
        institutionId,
        force: force ?? false,
        singleCourseId: canvasCourseId, // tells discover-courses to filter to this one course
      }),
    }));

    logger.info('SyncOrchestrator: single course SFN started', { institutionId, canvasCourseId, force });
  }
}
