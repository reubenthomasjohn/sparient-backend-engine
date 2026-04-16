import { Institution, Course } from '@prisma/client';
import prisma from '../../db/client';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { FileChangeDetector } from '../../services/sync/FileChangeDetector';
import { BatchBuilder } from '../../services/sync/BatchBuilder';
import { UploadJob } from '../../queue';
import { s3Service } from '../../services/storage/S3Service';
import { computeFailureUpdate } from '../../utils/failure';
import { logger } from '../../utils/logger';

const changeDetector = new FileChangeDetector();
const batchBuilder = new BatchBuilder();

// ---------------------------------------------------------------------------
// Step 1: Discover files for a course. Returns the list of uploads needed.
// ---------------------------------------------------------------------------

export interface DiscoverFilesInput {
  step: 'discover-files';
  institutionId: string;
  canvasCourseId: string;
  force?: boolean;
}

export interface DiscoverFilesOutput {
  institutionId: string;
  canvasCourseId: string;
  courseId: string;       // internal UUID
  isInitialSync: boolean;
  uploadJobs: UploadJob[];
}

export async function discoverFiles(input: DiscoverFilesInput): Promise<DiscoverFilesOutput> {
  const { institution, sourceClient } = await loadInstitution(input.institutionId);

  let course = await prisma.course.findFirst({
    where: { institutionId: input.institutionId, canvasCourseId: input.canvasCourseId },
  });

  // Course row might be missing (data wipe, first-ever sync).
  if (!course) {
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
    course = await prisma.course.findFirst({
      where: { institutionId: input.institutionId, canvasCourseId: input.canvasCourseId },
    });
    if (!course) {
      logger.warn('DiscoverFiles: course not found in Canvas', input);
      return {
        institutionId: input.institutionId,
        canvasCourseId: input.canvasCourseId,
        courseId: '',
        isInitialSync: true,
        uploadJobs: [],
      };
    }
  }

  const isInitialSync = !course.lastSyncedAt;
  const discovered = await sourceClient.getFiles(
    input.canvasCourseId,
    input.force ? null : course.lastSyncedAt,
  );
  const result = await changeDetector.detect(course, discovered);

  logger.info('DiscoverFiles: complete', {
    courseId: course.id,
    canvasCourseId: input.canvasCourseId,
    uploadsNeeded: result.toUploadJobs.length,
    deleted: result.deletedCount,
  });

  return {
    institutionId: input.institutionId,
    canvasCourseId: input.canvasCourseId,
    courseId: course.id,
    isInitialSync,
    uploadJobs: result.toUploadJobs,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Upload a single file. Invoked by the Map state in parallel.
// ---------------------------------------------------------------------------

export interface UploadFileInput {
  step: 'upload-file';
  sourceFileId: string;
  modifiedAtMs: number;
  institutionId: string;
}

export interface UploadFileOutput {
  sourceFileId: string;
  success: boolean;
  s3Key?: string;
  error?: string;
}

export async function uploadFile(input: UploadFileInput): Promise<UploadFileOutput> {
  // Reuse the existing upload handler logic.
  const { handleUploadJob } = await import('../upload/handler');
  try {
    await handleUploadJob({ sourceFileId: input.sourceFileId, modifiedAtMs: input.modifiedAtMs });
    return { sourceFileId: input.sourceFileId, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('UploadFile: failed', { sourceFileId: input.sourceFileId, error: message });
    // Don't throw — let the Map state Catch/Retry handle it if configured,
    // but return the error so batch step knows which files failed.
    return { sourceFileId: input.sourceFileId, success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Step 3: Batch all uploaded files + publish request.json.
// ---------------------------------------------------------------------------

export interface BatchPublishInput {
  step: 'batch-publish';
  institutionId: string;
  canvasCourseId: string;
  courseId: string;
  isInitialSync: boolean;
  uploadResults: UploadFileOutput[];
}

export interface BatchPublishOutput {
  batchId: string | null;
  fileCount: number;
}

export async function batchPublish(input: BatchPublishInput): Promise<BatchPublishOutput> {
  if (!input.courseId) {
    logger.warn('BatchPublish: no courseId (course was not found in discover step)');
    return { batchId: null, fileCount: 0 };
  }

  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: input.institutionId },
  });
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: input.courseId },
  });

  // Retry any previously failed files for this course while we're here.
  await retryCourseFiles(input.courseId);
  await releaseStuckBatches(input.courseId);

  const batch = await batchBuilder.buildForCourse(institution, course, {
    isInitialSync: input.isInitialSync,
  });

  // Update course lastSyncedAt.
  await prisma.course.update({
    where: { id: input.courseId },
    data: { lastSyncedAt: new Date() },
  });

  const succeeded = input.uploadResults?.filter((r) => r.success).length ?? 0;
  const failed = input.uploadResults?.filter((r) => !r.success).length ?? 0;

  logger.info('BatchPublish: complete', {
    courseId: input.courseId,
    batchId: batch?.id ?? null,
    fileCount: batch?.totalFiles ?? 0,
    uploadsSucceeded: succeeded,
    uploadsFailed: failed,
  });

  return {
    batchId: batch?.id ?? null,
    fileCount: batch?.totalFiles ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-course retry + cleanup (moved from discovery handler)
// ---------------------------------------------------------------------------

async function retryCourseFiles(courseId: string): Promise<void> {
  const eligible = await prisma.sourceFile.findMany({
    where: { courseId, lastOutcome: 'failed' },
    select: { id: true, retryCount: true, maxRetries: true },
  });

  const retriable = eligible.filter((f) => f.retryCount < f.maxRetries);
  if (retriable.length === 0) return;

  // Clear outcome so these files become eligible for the current batch.
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

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function loadInstitution(institutionId: string) {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: institutionId },
  });
  const sourceClient = SourceRegistry.getClient(institution);
  return { institution, sourceClient };
}
