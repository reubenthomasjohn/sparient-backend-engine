import { Institution, Course } from '@prisma/client';
import prisma from '../../db/client';
import { SourceRegistry } from '../sources/SourceRegistry';
import { s3Service } from '../storage/S3Service';
import { FileChangeDetector } from './FileChangeDetector';
import { BatchBuilder } from './BatchBuilder';
import { logger } from '../../utils/logger';
import { DiscoveredFile } from '../../types/source';

export class SyncOrchestrator {
  private readonly changeDetector = new FileChangeDetector();
  private readonly batchBuilder = new BatchBuilder();

  // Entry point for the nightly cron and the manual API trigger.
  // If courseId is provided, only that course is synced.
  async syncInstitution(institutionId: string, courseId?: string): Promise<void> {
    const institution = await prisma.institution.findUniqueOrThrow({
      where: { id: institutionId },
    });

    if (!institution.syncEnabled) {
      logger.info('SyncOrchestrator: institution sync disabled, skipping', { institutionId });
      return;
    }

    logger.info('SyncOrchestrator: starting sync', { institutionId, courseId });

    const sourceClient = SourceRegistry.getClient(institution);

    // Discover and upsert courses from the source
    const discoveredCourses = await sourceClient.getCourses();
    await this.upsertCourses(institution, discoveredCourses);

    // Determine which courses to sync
    const whereClause = {
      institutionId,
      syncEnabled: true,
      ...(courseId ? { id: courseId } : {}),
    };

    const courses = await prisma.course.findMany({ where: whereClause });

    if (courses.length === 0) {
      logger.info('SyncOrchestrator: no eligible courses found', { institutionId });
      return;
    }

    for (const course of courses) {
      try {
        await this.syncCourse(institution, course);
      } catch (err) {
        // Log and continue — a failure in one course must not halt others
        logger.error('SyncOrchestrator: course sync failed', {
          institutionId,
          courseId: course.id,
          error: err,
        });
      }
    }

    logger.info('SyncOrchestrator: sync complete', { institutionId });
  }

  private async syncCourse(institution: Institution, course: Course): Promise<void> {
    logger.info('SyncOrchestrator: syncing course', {
      institutionId: institution.id,
      courseId: course.id,
      canvasCourseId: course.canvasCourseId,
    });

    const sourceClient = SourceRegistry.getClient(institution);
    const isInitialSync = !course.lastSyncedAt;

    // Fetch files from source — passes lastSyncedAt for incremental filtering
    const discoveredFiles = await sourceClient.getFiles(
      course.canvasCourseId,
      course.lastSyncedAt,
    );

    // Determine what needs to happen to each file
    const { toUpload, toDelete } = await this.changeDetector.detect(course, discoveredFiles);

    // Upload new/changed files to S3
    for (const file of toUpload) {
      await this.uploadFileToS3(institution, course, file);
    }

    // Mark deleted files
    if (toDelete.length > 0) {
      await prisma.sourceFile.updateMany({
        where: {
          courseId: course.id,
          canvasFileId: { in: toDelete },
        },
        data: { status: 'deleted_from_source' },
      });
      logger.info('SyncOrchestrator: marked files as deleted', {
        courseId: course.id,
        count: toDelete.length,
      });
    }

    // Collect all files that are ready to be batched
    const readyFiles = await prisma.sourceFile.findMany({
      where: { courseId: course.id, status: 'ready' },
    });

    if (readyFiles.length > 0) {
      await this.batchBuilder.createBatch(institution, course, readyFiles, { isInitialSync });
    } else {
      logger.info('SyncOrchestrator: no ready files for batch', { courseId: course.id });
    }

    // Record sync time
    await prisma.course.update({
      where: { id: course.id },
      data: { lastSyncedAt: new Date() },
    });

    logger.info('SyncOrchestrator: course sync complete', { courseId: course.id });
  }

  private async uploadFileToS3(
    institution: Institution,
    course: Course,
    file: DiscoveredFile,
  ): Promise<void> {
    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({
      where: { courseId_canvasFileId: { courseId: course.id, canvasFileId: file.externalId } },
    });

    try {
      await prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: { status: 'uploading_to_s3' },
      });

      const s3Key = s3Service.buildSourceKey(
        institution.slug,
        course.canvasCourseId,
        file.externalId,
        file.fileName,
      );

      const fileBuffer = await SourceRegistry.getClient(institution).downloadFile(file.downloadUrl);

      await s3Service.uploadSourceFile(s3Key, fileBuffer, file.mimeType);

      await prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          status: 'ready',
          s3SourceKey: s3Key,
          s3SourceBucket: (await import('../../config')).config.aws.s3SourceBucket,
        },
      });

      logger.info('SyncOrchestrator: file uploaded to S3', { fileId: sourceFile.id, s3Key });
    } catch (err) {
      await prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          status: 'failed',
          lastFailureReason: err instanceof Error ? err.message : String(err),
        },
      });
      logger.error('SyncOrchestrator: S3 upload failed', { fileId: sourceFile.id, error: err });
    }
  }

  private async upsertCourses(
    institution: Institution,
    discoveredCourses: import('../../types/source').DiscoveredCourse[],
  ): Promise<void> {
    for (const discovered of discoveredCourses) {
      await prisma.course.upsert({
        where: {
          institutionId_canvasCourseId: {
            institutionId: institution.id,
            canvasCourseId: discovered.externalId,
          },
        },
        create: {
          institutionId: institution.id,
          canvasCourseId: discovered.externalId,
          canvasTermId: discovered.termId,
          name: discovered.name,
          courseCode: discovered.courseCode,
        },
        update: {
          name: discovered.name,
          courseCode: discovered.courseCode,
          canvasTermId: discovered.termId,
        },
      });
    }
  }
}
