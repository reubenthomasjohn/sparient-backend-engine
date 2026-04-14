import prisma from '../../db/client';
import { DiscoveryJob, uploadQueue } from '../../queue';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { FileChangeDetector } from '../../services/sync/FileChangeDetector';
import { BatchBuilder } from '../../services/sync/BatchBuilder';
import { logger } from '../../utils/logger';

const changeDetector = new FileChangeDetector();
const batchBuilder = new BatchBuilder();

// Handles a single discovery job. Runs for every active-term course (or just one,
// when job.courseId is set). Idempotent — safe to run concurrently with other
// discovery jobs for the same institution; per-file claims handle the races.
export async function handleDiscoveryJob(job: DiscoveryJob): Promise<void> {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: job.institutionId },
  });
  const sourceClient = SourceRegistry.getClient(institution);

  const discoveredCourses = await sourceClient.getCourses();
  for (const dc of discoveredCourses) {
    await prisma.course.upsert({
      where: {
        institutionId_canvasCourseId: {
          institutionId: institution.id,
          canvasCourseId: dc.externalId,
        },
      },
      create: {
        institutionId: institution.id,
        canvasCourseId: dc.externalId,
        canvasTermId: dc.termId,
        name: dc.name,
        courseCode: dc.courseCode,
      },
      update: {
        name: dc.name,
        courseCode: dc.courseCode,
        canvasTermId: dc.termId,
      },
    });
  }

  const activeIds = new Set(discoveredCourses.map((c) => c.externalId));
  const canvasIds = job.courseId
    ? (activeIds.has(job.courseId) ? [job.courseId] : [])
    : Array.from(activeIds);

  if (canvasIds.length === 0) {
    logger.info('Discovery: no eligible courses', { institutionId: institution.id });
    return;
  }

  const courses = await prisma.course.findMany({
    where: { institutionId: institution.id, canvasCourseId: { in: canvasIds } },
  });

  for (const course of courses) {
    try {
      // syncStartedAt is captured *before* listing files so any file uploaded during
      // this run is caught on the next pass. See SYNC_EDGE_CASES.md §2.2.
      const syncStartedAt = new Date();
      const isInitialSync = !course.lastSyncedAt;

      const discovered = await sourceClient.getFiles(
        course.canvasCourseId,
        course.lastSyncedAt,
      );
      const result = await changeDetector.detect(course, discovered);

      for (const uj of result.toUploadJobs) {
        await uploadQueue.send(uj);
      }

      // Any files already uploaded in a previous run are waiting for batching — pick them up now.
      // The upload worker also calls buildForCourse after a successful upload so newly-uploaded
      // files don't need to wait for the next discovery pass.
      await batchBuilder.buildForCourse(institution, course, { isInitialSync });

      await prisma.course.update({
        where: { id: course.id },
        data: { lastSyncedAt: syncStartedAt },
      });

      logger.info('Discovery: course complete', {
        courseId: course.id,
        uploadsQueued: result.toUploadJobs.length,
        deleted: result.deletedCount,
      });
    } catch (err) {
      logger.error('Discovery: course failed', { courseId: course.id, error: err });
    }
  }
}
