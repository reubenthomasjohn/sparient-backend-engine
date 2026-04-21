import { Institution } from '@prisma/client';
import prisma from '../../db/client';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { ISourceClient } from '../../services/sources/ISourceClient';
import { FileChangeDetector } from '../../services/sync/FileChangeDetector';
import { BatchBuilder } from '../../services/sync/BatchBuilder';
import { logger } from '../../utils/logger';

const changeDetector = new FileChangeDetector();
const batchBuilder = new BatchBuilder();

// ---------------------------------------------------------------------------
// Step 0: Discover courses for an institution. Returns the course list for
// the outer Map state. Called once per SFN execution.
// ---------------------------------------------------------------------------

export interface DiscoverCoursesInput {
  step: 'discover-courses';
  institutionId: string;
  force?: boolean;
  singleCourseId?: string;  // if set, only process this one course (manual single-course sync)
}

export interface DiscoverCoursesOutput {
  institutionId: string;
  force: boolean;
  courses: { canvasCourseId: string; courseId: string }[];
}

export async function discoverCourses(input: DiscoverCoursesInput): Promise<DiscoverCoursesOutput> {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: input.institutionId },
  });
  const sourceClient = SourceRegistry.getClient(institution);

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

  // Fetch the internal UUIDs for the Map state. If singleCourseId is set,
  // filter to just that course (manual single-course sync via API).
  const courseFilter = input.singleCourseId
    ? [input.singleCourseId]
    : discovered.map((c) => c.externalId);

  const courses = await prisma.course.findMany({
    where: {
      institutionId: institution.id,
      canvasCourseId: { in: courseFilter },
    },
    select: { id: true, canvasCourseId: true },
  });

  logger.info('DiscoverCourses: complete', {
    institutionId: input.institutionId,
    courseCount: courses.length,
  });

  return {
    institutionId: input.institutionId,
    force: input.force ?? false,
    courses: courses.map((c) => ({ canvasCourseId: c.canvasCourseId, courseId: c.id })),
  };
}

// ---------------------------------------------------------------------------
// Step 1: Discover files for a single course. Returns file IDs (not full
// payloads) — the Upload step reads file data from DB.
// ---------------------------------------------------------------------------

export interface DiscoverFilesInput {
  step: 'discover-files';
  institutionId: string;
  canvasCourseId: string;
  courseId: string;
  force?: boolean;
}

export interface DiscoverFilesOutput {
  institutionId: string;
  canvasCourseId: string;
  courseId: string;
  isInitialSync: boolean;
  hasWork: boolean;
  fileIds: string[];    // source_file UUIDs that need uploading
}

export async function discoverFiles(input: DiscoverFilesInput): Promise<DiscoverFilesOutput> {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: input.institutionId },
  });
  const sourceClient = SourceRegistry.getClient(institution);

  const course = await prisma.course.findUniqueOrThrow({
    where: { id: input.courseId },
  });

  const isInitialSync = !course.lastSyncedAt;
  const discovered = await sourceClient.getFiles(
    input.canvasCourseId,
    input.force ? null : course.lastSyncedAt,
  );
  const result = await changeDetector.detect(course, discovered);

  // Return just the IDs — upload step reads full data from DB.
  const fileIds = result.toUploadJobs.map((j) => j.sourceFileId);

  // Check for retry-eligible files (respecting backoff window).
  const now = new Date();
  const retryCount = await prisma.sourceFile.count({
    where: {
      courseId: input.courseId,
      lastOutcome: 'failed',
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
  });

  const stuckBatchCount = await prisma.batch.count({
    where: { courseId: input.courseId, status: 'pending', requestWrittenAt: null },
  });

  // Check if there are files needing batching (uploaded but not yet batched).
  // Prisma can't express cross-column comparison, so use raw SQL for the COUNT.
  const [{ count: needsBatchingCount }] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM source_files
    WHERE course_id = ${input.courseId}
      AND s3_source_key IS NOT NULL
      AND s3_source_modified_at IS NOT NULL
      AND (last_outcome IS NULL OR last_outcome NOT IN ('deleted', 'permanently_failed'))
      AND (batched_modified_at IS NULL OR s3_source_modified_at > batched_modified_at)
  `;
  const needsBatching = Number(needsBatchingCount);

  const hasWork = fileIds.length > 0 || retryCount > 0 || stuckBatchCount > 0 || needsBatching > 0;

  logger.info('DiscoverFiles: complete', {
    courseId: input.courseId,
    canvasCourseId: input.canvasCourseId,
    uploadsNeeded: fileIds.length,
    retryEligible: retryCount,
    stuckBatches: stuckBatchCount,
    hasWork,
    deleted: result.deletedCount,
  });

  return {
    institutionId: input.institutionId,
    canvasCourseId: input.canvasCourseId,
    courseId: input.courseId,
    isInitialSync,
    hasWork,
    fileIds,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Upload a single file. Reads file data from DB by ID.
// ---------------------------------------------------------------------------

export interface UploadFileInput {
  step: 'upload-file';
  sourceFileId: string;
}

export interface UploadFileOutput {
  sourceFileId: string;
  success: boolean;
  error?: string;
}

export async function uploadFile(input: UploadFileInput): Promise<UploadFileOutput> {
  const row = await prisma.sourceFile.findUnique({
    where: { id: input.sourceFileId },
  });

  if (!row) {
    logger.warn('UploadFile: source_file not found', { sourceFileId: input.sourceFileId });
    return { sourceFileId: input.sourceFileId, success: false, error: 'not found' };
  }

  const { handleUploadJob } = await import('../upload/handler');
  try {
    await handleUploadJob({
      sourceFileId: input.sourceFileId,
      modifiedAtMs: row.discoveredModifiedAt.getTime(),
    });
    return { sourceFileId: input.sourceFileId, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('UploadFile: failed', { sourceFileId: input.sourceFileId, error: message });
    return { sourceFileId: input.sourceFileId, success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Step 3: Batch all uploaded files + publish request.json. Reads eligible
// files from DB — doesn't rely on SFN payload for file data.
// ---------------------------------------------------------------------------

export interface BatchPublishInput {
  step: 'batch-publish';
  institutionId: string;
  canvasCourseId: string;
  courseId: string;
  isInitialSync: boolean;
}

export interface BatchPublishOutput {
  batchId: string | null;
  fileCount: number;
}

export async function batchPublish(input: BatchPublishInput): Promise<BatchPublishOutput> {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: input.institutionId },
  });
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: input.courseId },
  });

  // Retry failed files + release stuck batches before batching.
  await retryCourseFiles(input.courseId);
  await releaseStuckBatches(input.courseId);

  const batch = await batchBuilder.buildForCourse(institution, course, {
    isInitialSync: input.isInitialSync,
  });

  await prisma.course.update({
    where: { id: input.courseId },
    data: { lastSyncedAt: new Date() },
  });

  logger.info('BatchPublish: complete', {
    courseId: input.courseId,
    batchId: batch?.id ?? null,
    fileCount: batch?.totalFiles ?? 0,
  });

  return {
    batchId: batch?.id ?? null,
    fileCount: batch?.totalFiles ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-course retry + cleanup
// ---------------------------------------------------------------------------

async function retryCourseFiles(courseId: string): Promise<void> {
  const now = new Date();
  const eligible = await prisma.sourceFile.findMany({
    where: {
      courseId,
      lastOutcome: 'failed',
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    select: { id: true, retryCount: true, maxRetries: true },
  });

  // Prisma can't express retryCount < maxRetries cross-column, so filter in JS.
  const retriable = eligible.filter((f) => f.retryCount < f.maxRetries);
  if (retriable.length === 0) return;

  await prisma.sourceFile.updateMany({
    where: { id: { in: retriable.map((f) => f.id) } },
    data: {
      lastOutcome: null,
      batchedModifiedAt: null,
      nextRetryAt: null,
      lastFailureReason: null,
    },
  });

  logger.info('BatchPublish: retried files', { courseId, count: retriable.length });
}

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

  logger.info('BatchPublish: released stuck batches', { courseId, count: stuck.length });
}
