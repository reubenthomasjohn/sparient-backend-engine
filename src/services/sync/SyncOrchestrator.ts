import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import prisma from '../../db/client';
import { discoveryQueue } from '../../queue';
import { config } from '../../config';
import { getBucketName } from '../../config/s3Bucket';
import { logger } from '../../utils/logger';

const sfn = new SFNClient({ region: config.aws.region });

export class SyncOrchestrator {
  async syncInstitution(institutionId: string, force?: boolean): Promise<void> {
    await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });
    await discoveryQueue.send({ type: 'discover', institutionId, force });
    logger.info('SyncOrchestrator: institution discover enqueued', { institutionId, force });
  }

  async syncCourse(institutionId: string, canvasCourseId: string, force?: boolean): Promise<void> {
    const institution = await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });

    if (!config.aws.courseWorkflowArn) {
      // Local dev fallback
      const { discoverFiles, batchPublish } = await import('../../workers/course/handler');
      const s3Bucket = getBucketName(institutionId, institution.s3Bucket);
      const course = await prisma.course.findFirst({
        where: { institutionId, canvasCourseId },
      });
      const result = await discoverFiles({
        step: 'discover-files',
        institutionId,
        s3Bucket,
        canvasCourseId,
        courseId: course?.id ?? '',
        force,
      });
      if (result.hasWork) {
        await batchPublish({
          step: 'batch-publish',
          institutionId,
          s3Bucket,
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
        singleCourseId: canvasCourseId,
      }),
    }));

    logger.info('SyncOrchestrator: single course SFN started', { institutionId, canvasCourseId, force });
  }
}
