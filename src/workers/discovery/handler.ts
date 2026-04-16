import { Institution } from '@prisma/client';
import prisma from '../../db/client';
import { DiscoveryJob, discoveryQueue, uploadQueue } from '../../queue';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { ISourceClient } from '../../services/sources/ISourceClient';
import { FileChangeDetector } from '../../services/sync/FileChangeDetector';
import { BatchBuilder } from '../../services/sync/BatchBuilder';
import { logger } from '../../utils/logger';

const changeDetector = new FileChangeDetector();
const batchBuilder = new BatchBuilder();

// ---------------------------------------------------------------------------
// Entry point — routes by message type.
// ---------------------------------------------------------------------------

export async function handleDiscoveryJob(job: DiscoveryJob): Promise<void> {
  if (job.type === 'tick') {
    return runTick();
  }
  if (job.courseId) {
    return discoverCourse(job.institutionId, job.courseId, job.force);
  }
  return discoverInstitution(job.institutionId, job.force);
}

// ---------------------------------------------------------------------------
// Tick — every 15 min (EventBridge). Lightweight: just a DB query + enqueue.
// ---------------------------------------------------------------------------

async function runTick(): Promise<void> {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const institutions = await prisma.institution.findMany({
    where: { syncEnabled: true },
  });

  const due = institutions.filter((inst) => {
    // Parse "HH:MM" → minutes since midnight
    const [h, m] = inst.syncTime.split(':').map(Number);
    const scheduledMinutes = h * 60 + m;

    // Due if current time is within 15-min window of sync_time
    const diff = currentMinutes - scheduledMinutes;
    if (diff < 0 || diff >= 15) return false;

    // And not already synced today
    if (inst.lastSyncedAt && inst.lastSyncedAt >= todayStart) return false;

    return true;
  });

  if (due.length === 0) {
    logger.info('Tick: no institutions due');
    return;
  }

  for (const inst of due) {
    await discoveryQueue.send({ type: 'discover', institutionId: inst.id });
  }

  logger.info('Tick: institutions enqueued', { count: due.length });
}

// ---------------------------------------------------------------------------
// Institution discover — list courses from Canvas, upsert, fan out per course.
// ---------------------------------------------------------------------------

async function discoverInstitution(institutionId: string, force?: boolean): Promise<void> {
  const { institution, sourceClient } = await loadInstitution(institutionId);

  const courses = await upsertCoursesFromCanvas(institution, sourceClient);

  for (const c of courses) {
    await discoveryQueue.send({
      type: 'discover',
      institutionId,
      courseId: c.externalId,
      force,
    });
  }

  await prisma.institution.update({
    where: { id: institution.id },
    data: { lastSyncedAt: new Date() },
  });

  logger.info('Discovery: institution fan-out complete', {
    institutionId,
    coursesEnqueued: courses.length,
  });
}

// ---------------------------------------------------------------------------
// Course discover — list files for one course, detect changes, enqueue uploads,
// batch + publish, then handle retries + stuck batches for this course.
// ---------------------------------------------------------------------------

async function discoverCourse(
  institutionId: string,
  canvasCourseId: string,
  force?: boolean,
): Promise<void> {
  const { institution, sourceClient } = await loadInstitution(institutionId);

  let course = await prisma.course.findFirst({
    where: { institutionId, canvasCourseId },
  });

  // Course row might be missing (data wipe, first-ever single-course sync).
  if (!course) {
    await upsertCoursesFromCanvas(institution, sourceClient);
    course = await prisma.course.findFirst({
      where: { institutionId, canvasCourseId },
    });
    if (!course) {
      logger.warn('Discovery: course not found in Canvas', { institutionId, canvasCourseId });
      return;
    }
  }

  const syncStartedAt = new Date();
  const isInitialSync = !course.lastSyncedAt;

  const discovered = await sourceClient.getFiles(
    canvasCourseId,
    force ? null : course.lastSyncedAt,
  );
  const result = await changeDetector.detect(course, discovered);

  for (const uj of result.toUploadJobs) {
    await uploadQueue.send(uj);
  }

  await batchBuilder.buildForCourse(institution, course, { isInitialSync });

  // Retry failed files + release stuck batches for this course — happens naturally
  // as part of each sync pass, no separate scheduled job needed.
  await retryCourseFiles(course.id);
  await releaseStuckBatches(course.id);

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

// ---------------------------------------------------------------------------
// Per-course retry + cleanup (replaces the old sweep functions)
// ---------------------------------------------------------------------------

// Re-enqueue failed files that still have retries left.
async function retryCourseFiles(courseId: string): Promise<void> {
  const eligible = await prisma.sourceFile.findMany({
    where: { courseId, lastOutcome: 'failed' },
    select: {
      id: true,
      s3SourceKey: true,
      retryCount: true,
      maxRetries: true,
      discoveredModifiedAt: true,
    },
  });

  const retriable = eligible.filter((f) => f.retryCount < f.maxRetries);
  if (retriable.length === 0) return;

  const needUpload = retriable.filter((f) => !f.s3SourceKey);
  const needBatch = retriable.filter((f) => f.s3SourceKey);

  for (const f of needUpload) {
    await uploadQueue.send({
      sourceFileId: f.id,
      modifiedAtMs: f.discoveredModifiedAt.getTime(),
    });
  }

  if (needBatch.length > 0) {
    await prisma.sourceFile.updateMany({
      where: { id: { in: needBatch.map((f) => f.id) } },
      data: {
        lastOutcome: null,
        batchedModifiedAt: null,
        nextRetryAt: null,
        lastFailureReason: null,
      },
    });
  }

  if (needUpload.length > 0 || needBatch.length > 0) {
    logger.info('Discovery: retries for course', {
      courseId,
      reuploads: needUpload.length,
      rebatches: needBatch.length,
    });
  }
}

// Release batches where claim succeeded but S3 publish failed + rollback also failed.
async function releaseStuckBatches(courseId: string): Promise<void> {
  const stuck = await prisma.batch.findMany({
    where: { courseId, status: 'pending', requestWrittenAt: null },
    include: { batchFiles: true },
  });

  if (stuck.length === 0) return;

  for (const batch of stuck) {
    await prisma.sourceFile.updateMany({
      where: { id: { in: batch.batchFiles.map((bf) => bf.sourceFileId) } },
      data: { batchedModifiedAt: null },
    });
    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: 'failed' },
    });
  }

  logger.info('Discovery: released stuck batches', { courseId, count: stuck.length });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadInstitution(institutionId: string) {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: institutionId },
  });
  const sourceClient = SourceRegistry.getClient(institution);
  return { institution, sourceClient };
}

async function upsertCoursesFromCanvas(institution: Institution, sourceClient: ISourceClient) {
  const discovered = await sourceClient.getCourses();
  for (const dc of discovered) {
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
  return discovered;
}
