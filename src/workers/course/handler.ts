import { Institution } from '@prisma/client';
import prisma from '../../db/client';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { ISourceClient } from '../../services/sources/ISourceClient';
import { FileChangeDetector } from '../../services/sync/FileChangeDetector';
import { BatchBuilder } from '../../services/sync/BatchBuilder';
import { getBucketName } from '../../config/s3Bucket';
import { logger } from '../../utils/logger';

const changeDetector = new FileChangeDetector();
const batchBuilder = new BatchBuilder();

// ---------------------------------------------------------------------------
// Step 0: Discover courses. Resolves s3Bucket once, flows to all downstream steps.
// ---------------------------------------------------------------------------

export interface DiscoverCoursesInput {
  step: 'discover-courses';
  institutionId: string;
  force?: boolean;
  singleCourseId?: string;
}

export interface DiscoverCoursesOutput {
  institutionId: string;
  s3Bucket: string;
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

  // Resolve bucket once — flows through the Map to all downstream steps.
  const s3Bucket = getBucketName(institution.id, institution.s3Bucket);

  logger.info('DiscoverCourses: complete', {
    institutionId: input.institutionId,
    s3Bucket,
    courseCount: courses.length,
  });

  return {
    institutionId: input.institutionId,
    s3Bucket,
    force: input.force ?? false,
    courses: courses.map((c) => ({ canvasCourseId: c.canvasCourseId, courseId: c.id })),
  };
}

// ---------------------------------------------------------------------------
// Step 1: Discover files for a single course.
// ---------------------------------------------------------------------------

export interface DiscoverFilesInput {
  step: 'discover-files';
  institutionId: string;
  s3Bucket: string;
  canvasCourseId: string;
  courseId: string;
  force?: boolean;
}

export interface DiscoverFilesOutput {
  institutionId: string;
  s3Bucket: string;
  canvasCourseId: string;
  courseId: string;
  isInitialSync: boolean;
  hasWork: boolean;
  fileIds: string[];
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

  const fileIds = result.toUploadJobs.map((j) => j.sourceFileId);

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
    s3Bucket: input.s3Bucket,
    canvasCourseId: input.canvasCourseId,
    courseId: input.courseId,
    isInitialSync,
    hasWork,
    fileIds,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Upload a single file.
// ---------------------------------------------------------------------------

export interface UploadFileInput {
  step: 'upload-file';
  sourceFileId: string;
  s3Bucket: string;
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
      s3Bucket: input.s3Bucket,
    });
    return { sourceFileId: input.sourceFileId, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('UploadFile: failed', { sourceFileId: input.sourceFileId, error: message });
    return { sourceFileId: input.sourceFileId, success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Step 3: Batch + publish.
// ---------------------------------------------------------------------------

export interface BatchPublishInput {
  step: 'batch-publish';
  institutionId: string;
  s3Bucket: string;
  canvasCourseId: string;
  courseId: string;
  isInitialSync: boolean;
  force?: boolean;
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

  const hadRetries = await retryCourseFiles(input.courseId);
  await releaseStuckBatches(input.courseId);

  const batch = await batchBuilder.buildForCourse(institution, course, {
    isInitialSync: input.isInitialSync,
    forceReprocess: input.force || hadRetries,
    s3Bucket: input.s3Bucket,
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

async function retryCourseFiles(courseId: string): Promise<boolean> {
  const now = new Date();
  const eligible = await prisma.sourceFile.findMany({
    where: {
      courseId,
      lastOutcome: 'failed',
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    select: { id: true, retryCount: true, maxRetries: true },
  });

  const retriable = eligible.filter((f) => f.retryCount < f.maxRetries);
  if (retriable.length === 0) return false;

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
  return true;
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
