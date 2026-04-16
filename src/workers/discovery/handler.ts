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
  await sweepUnpublishedBatches();

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
      data: { lastOutcome: null, batchedModifiedAt: null, nextRetryAt: null, lastFailureReason: null },
    });
  }

  logger.info('Discovery sweep: retries queued', {
    reuploads: needUpload.length,
    rebatches: needBatch.length,
  });
}

// Catches batches where the DB claim succeeded but S3 publish failed AND the rollback
// also failed (double fault). These batches are pending with requestWrittenAt=null.
// We release the claimed files so they become eligible again.
async function sweepUnpublishedBatches(): Promise<void> {
  const stuck = await prisma.batch.findMany({
    where: { status: 'pending', requestWrittenAt: null },
    include: { batchFiles: true },
  });

  if (stuck.length === 0) return;

  for (const batch of stuck) {
    const fileIds = batch.batchFiles.map((bf) => bf.sourceFileId);
    await prisma.sourceFile.updateMany({
      where: { id: { in: fileIds } },
      data: { batchedModifiedAt: null },
    });
    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: 'failed' },
    });
  }

  logger.info('Discovery sweep: released unpublished batches', { count: stuck.length });
}

// Two modes:
//   Without courseId → "institution discover": list courses from Canvas, upsert to DB,
//     fan out one {discover, institutionId, courseId} message per active course back to
//     the same queue. Each course gets its own Lambda invocation → parallelism, isolation.
//   With courseId → "course discover": process that one course (list files, detect changes,
//     enqueue uploads, batch + publish).
async function runDiscover(
  job: Extract<DiscoveryJob, { type: 'discover' }>,
): Promise<void> {
  if (job.courseId) {
    await discoverCourse(job.institutionId, job.courseId, job.force);
  } else {
    await discoverInstitution(job.institutionId, job.force);
  }
}

// Lists all active-term courses from Canvas, upserts them to DB, then fans out one
// discovery message per course. The heavy per-course work happens in separate Lambda
// invocations — this one finishes quickly.
async function discoverInstitution(institutionId: string, force?: boolean): Promise<void> {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: institutionId },
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

  // Fan out: one message per active course, back to the same discovery queue.
  const activeIds = discoveredCourses.map((c) => c.externalId);
  for (const courseId of activeIds) {
    await discoveryQueue.send({ type: 'discover', institutionId, courseId, force });
  }

  // Mark the institution as synced now — individual course failures are retried by SQS.
  await prisma.institution.update({
    where: { id: institution.id },
    data: { lastSyncedAt: new Date() },
  });

  logger.info('Discovery: institution fan-out complete', {
    institutionId,
    coursesEnqueued: activeIds.length,
  });
}

// Processes a single course: list files, detect changes, enqueue uploads, batch + publish.
// Runs in its own Lambda invocation — a heavy course can't block others.
async function discoverCourse(
  institutionId: string,
  canvasCourseId: string,
  force?: boolean,
): Promise<void> {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: institutionId },
  });
  const sourceClient = SourceRegistry.getClient(institution);

  const course = await prisma.course.findFirst({
    where: { institutionId, canvasCourseId },
  });
  if (!course) {
    logger.warn('Discovery: course not found in DB', { institutionId, canvasCourseId });
    return;
  }

  const syncStartedAt = new Date();
  const isInitialSync = !course.lastSyncedAt;

  const discovered = await sourceClient.getFiles(
    course.canvasCourseId,
    force ? null : course.lastSyncedAt,
  );
  const result = await changeDetector.detect(course, discovered);

  for (const uj of result.toUploadJobs) {
    await uploadQueue.send(uj);
  }

  // Batch any files already in S3 from a previous upload pass.
  await batchBuilder.buildForCourse(institution, course, { isInitialSync });

  await prisma.course.update({
    where: { id: course.id },
    data: { lastSyncedAt: syncStartedAt },
  });

  logger.info('Discovery: course complete', {
    courseId: course.id,
    canvasCourseId,
    uploadsQueued: result.toUploadJobs.length,
    deleted: result.deletedCount,
  });
}
