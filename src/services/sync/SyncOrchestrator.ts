import { Institution, Course } from "@prisma/client";
import prisma from "../../db/client";
import { SourceRegistry } from "../sources/SourceRegistry";
import { s3Service } from "../storage/S3Service";
import { FileChangeDetector } from "./FileChangeDetector";
import { BatchBuilder } from "./BatchBuilder";
import { logger } from "../../utils/logger";
import { DiscoveredFile } from "../../types/source";

export class SyncOrchestrator {
  private readonly changeDetector = new FileChangeDetector();
  private readonly batchBuilder = new BatchBuilder();

  // Entry point for the nightly cron and the manual API trigger.
  // If courseId is provided, only that course is synced.
  async syncInstitution(
    institutionId: string,
    courseId?: string,
  ): Promise<void> {
    const institution = await prisma.institution.findUniqueOrThrow({
      where: { id: institutionId },
    });

    logger.info("SyncOrchestrator: starting sync", { institutionId, courseId });

    const sourceClient = SourceRegistry.getClient(institution);

    // Discover active-term courses from the source and upsert them.
    // getCourses() already filters to courses whose term is currently active,
    // so the returned IDs are the authoritative set of what should be synced this run.
    const discoveredCourses = await sourceClient.getCourses();
    await this.upsertCourses(institution, discoveredCourses);

    // Build the set of currently-active Canvas course IDs so the DB query
    // honours the same term filter (rather than syncing all historical courses).
    const activeCanvasCourseIds = discoveredCourses.map((c) => c.externalId);

    // If a specific courseId was requested, only sync it if it's in an active term.
    const canvasCourseIdsToSync = courseId
      ? activeCanvasCourseIds.filter((id) => id === courseId)
      : activeCanvasCourseIds;

    const courses = await prisma.course.findMany({
      where: { institutionId, canvasCourseId: { in: canvasCourseIdsToSync } },
    });

    if (courses.length === 0) {
      logger.info("SyncOrchestrator: no eligible courses found", {
        institutionId,
      });
      return;
    }

    for (const course of courses) {
      try {
        await this.syncCourse(institution, course);
      } catch (err) {
        // Log and continue — a failure in one course must not halt others
        logger.error("SyncOrchestrator: course sync failed", {
          institutionId,
          courseId: course.id,
          error: err,
        });
      }
    }

    logger.info("SyncOrchestrator: sync complete", { institutionId });
  }

  private async syncCourse(
    institution: Institution,
    course: Course,
  ): Promise<void> {
    logger.info("SyncOrchestrator: syncing course", {
      institutionId: institution.id,
      courseId: course.id,
      canvasCourseId: course.canvasCourseId,
    });

    // Capture start time before fetching. We write this as lastSyncedAt after
    // the sync completes, so the next incremental sync uses it as the cutoff.
    // This means any file uploaded *during* this run will be caught next time,
    // closing the gap that would exist if we recorded the end time instead.
    const syncStartedAt = new Date();

    const sourceClient = SourceRegistry.getClient(institution);
    const isInitialSync = !course.lastSyncedAt;

    // Fetch files from source — passes lastSyncedAt for incremental filtering
    const discoveredFiles = await sourceClient.getFiles(
      course.canvasCourseId,
      course.lastSyncedAt,
    );

    // Determine what needs to happen to each file
    const { toUpload, toDelete } = await this.changeDetector.detect(
      course,
      discoveredFiles,
    );

    logger.info("SyncOrchestrator: change detection complete", {
      courseId: course.id,
      toUpload: toUpload.length,
      toDelete: toDelete.length,
    });

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
        data: { status: "deleted_from_source" },
      });
      logger.info("SyncOrchestrator: marked files as deleted", {
        courseId: course.id,
        count: toDelete.length,
      });
    }

    // Collect all files that are ready to be batched
    const readyFiles = await prisma.sourceFile.findMany({
      where: { courseId: course.id, status: "uploaded_to_s3" },
    });

    if (readyFiles.length > 0) {
      await this.batchBuilder.createBatch(institution, course, readyFiles, {
        isInitialSync,
      });
    } else {
      logger.info("SyncOrchestrator: no ready files for batch", {
        courseId: course.id,
      });
    }

    // Use the time captured at sync START, not now — see comment on syncStartedAt above.
    await prisma.course.update({
      where: { id: course.id },
      data: { lastSyncedAt: syncStartedAt },
    });

    logger.info("SyncOrchestrator: course sync complete", {
      courseId: course.id,
    });
  }

  private async uploadFileToS3(
    institution: Institution,
    course: Course,
    file: DiscoveredFile,
  ): Promise<void> {
    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({
      where: {
        courseId_canvasFileId: {
          courseId: course.id,
          canvasFileId: file.externalId,
        },
      },
    });

    try {
      await prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: { status: "uploading_to_s3" },
      });

      const s3Key = s3Service.buildSourceKey(
        institution.id,
        course.canvasCourseId,
        file.externalId,
        file.fileName,
      );

      const fileBuffer = await SourceRegistry.getClient(
        institution,
      ).downloadFile(file.downloadUrl);

      await s3Service.uploadSourceFile(s3Key, fileBuffer, file.mimeType);

      await prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          status: "uploaded_to_s3",
          s3SourceKey: s3Key,
          s3SourceBucket: (await import("../../config")).config.aws
            .s3SourceBucket,
        },
      });

      logger.info("SyncOrchestrator: file uploaded to S3", {
        fileId: sourceFile.id,
        s3Key,
      });
    } catch (err) {
      await prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: {
          status: "failed",
          lastFailureReason: err instanceof Error ? err.message : String(err),
        },
      });
      logger.error("SyncOrchestrator: S3 upload failed", {
        fileId: sourceFile.id,
        error: err,
      });
    }
  }

  private async upsertCourses(
    institution: Institution,
    discoveredCourses: import("../../types/source").DiscoveredCourse[],
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
