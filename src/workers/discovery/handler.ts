import prisma from '../../db/client';
import { DiscoveryJob, discoveryQueue, uploadQueue } from '../../queue';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { FileChangeDetector } from '../../services/sync/FileChangeDetector';
import { BatchBuilder } from '../../services/sync/BatchBuilder';
import { logger } from '../../utils/logger';

const changeDetector = new FileChangeDetector();
const batchBuilder = new BatchBuilder();

export async function handleDiscoveryJob(job: DiscoveryJob): Promise<void> {
  if (job.type === 'sweep') {
    await runSweep();
    return;
  }
  await runDiscover(job);
}

// Runs once per day (EventBridge in prod, nightly cron locally). Does two things:
//   1. Finds institutions due for a sync and enqueues a `discover` per institution.
//   2. Re-enqueues uploads / re-batches for files stuck in `failed` with retries left.
// Kept small and idempotent — SQS can redeliver, and duplicate per-institution jobs
// are safe (FileChangeDetector and BatchBuilder are idempotent).
async function runSweep(): Promise<void> {
  logger.info('Discovery sweep: start');

  const now = new Date();
  const institutions = await prisma.institution.findMany({
    where: { syncEnabled: true },
  });

  const due = institutions.filter((i) => {
    if (!i.lastSyncedAt) return true;
    const ageHours = (now.getTime() - i.lastSyncedAt.getTime()) / 3_600_000;
    return ageHours >= i.syncIntervalHours;
  });

  for (const inst of due) {
    await discoveryQueue.send({ type: 'discover', institutionId: inst.id });
  }
  logger.info('Discovery sweep: institutions enqueued', {
    enqueued: due.length,
    skipped: institutions.length - due.length,
  });

  await sweepRetries();

  logger.info('Discovery sweep: complete');
}

// Files with last_outcome='failed' and retries left come in two shapes:
//   - no s3_source_key → upload never succeeded; re-enqueue the upload
//   - s3_source_key set → remediation failed; clear the in-flight pin so BatchBuilder
//                         re-picks the file on the next per-institution discover pass
async function sweepRetries(): Promise<void> {
  const eligible = await prisma.sourceFile.findMany({
    where: { lastOutcome: 'failed' },
    select: {
      id: true,
      s3SourceKey: true,
      retryCount: true,
      maxRetries: true,
      discoveredModifiedAt: true,
    },
  });

  const retriable = eligible.filter((f) => f.retryCount < f.maxRetries);
  if (retriable.length === 0) {
    logger.info('Discovery sweep: no retry-eligible files');
    return;
  }

  const needUpload = retriable.filter((f) => !f.s3SourceKey);
  const needBatch = retriable.filter((f) => f.s3SourceKey);

  for (const f of needUpload) {
    await uploadQueue.send({
      sourceFileId: f.id,
      modifiedAtMs: f.discoveredModifiedAt.getTime(),
    });
  }

  if (needBatch.length > 0) {
    // Clear outcome + batched pin; next per-institution discovery pass will re-batch these.
    await prisma.sourceFile.updateMany({
      where: { id: { in: needBatch.map((f) => f.id) } },
      data: { lastOutcome: null, batchedModifiedAt: null, nextRetryAt: null },
    });
  }

  logger.info('Discovery sweep: retries queued', {
    reuploads: needUpload.length,
    rebatches: needBatch.length,
  });
}

// Runs per-institution. Courses are upserted from the source system, then each eligible
// course is discovered + batched. Idempotent — safe to run concurrently with other
// discovery jobs for the same institution; per-file claims handle the races.
async function runDiscover(
  job: Extract<DiscoveryJob, { type: 'discover' }>,
): Promise<void> {
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

  // Mark the institution itself as synced so the sweep's "due" check respects syncIntervalHours.
  await prisma.institution.update({
    where: { id: institution.id },
    data: { lastSyncedAt: new Date() },
  });
}
