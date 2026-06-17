import axios from "axios";
import { Readable } from "stream";
import { Institution } from "@prisma/client";
import { CanvasClient } from "./CanvasClient";
import { CanvasFileReplacer } from "./CanvasFileReplacer";
import { toDiscoveredCourse, toDiscoveredFile } from "./mappers";
import { ISourceClient } from "../ISourceClient";
import {
  DiscoveredCourse,
  DiscoveredFile,
  ReplaceEligibility,
  ReplaceFileParams,
  ReplaceResult,
  SupersedeFileParams,
  UploadNewFileParams,
} from "../../../types/source";
import { CanvasCourse, CanvasFile, CanvasTerm } from "../../../types/canvas";
import { logger } from "../../../utils/logger";
import {
  CourseState,
  EffectiveSyncConfig,
  getEffectiveSyncConfig,
} from "../../sync/syncConfig";

// Engine course-state vocabulary -> Canvas's state[] enum. Canvas has no "unpublished"
// state (it matches zero courses); pre-publish courses are created/claimed.
const CANVAS_STATE_MAP: Record<CourseState, string[]> = {
  available: ["available"],
  unpublished: ["created", "claimed"],
  completed: ["completed"],
};

function isActiveTerm(term: CanvasTerm, now: Date): boolean {
  if (term.start_at !== null && new Date(term.start_at) > now) return false;
  if (term.end_at !== null && new Date(term.end_at) < now) return false;
  return true;
}

// Module-private helper for log records (PII-safe replacement for filename).
function extractExtension(filename: string): string {
  const parts = filename.split('.');
  if (parts.length < 2) return '';
  return '.' + parts.pop()!.toLowerCase();
}

export class CanvasSourceClient implements ISourceClient {
  private readonly client: CanvasClient;
  private readonly replacer: CanvasFileReplacer;
  // Resolved once from institution.syncConfig. Null syncConfig -> conservative defaults
  // (6 basic file types, states available/unpublished); widen the pool via explicit PATCH.
  private readonly syncConfig: EffectiveSyncConfig;

  constructor(institution: Institution) {
    const credentials = institution.credentials as {
      domain: string;
      account_id: string;
      api_token: string;
    };
    this.client = new CanvasClient(credentials);
    this.replacer = new CanvasFileReplacer(this.client);
    this.syncConfig = getEffectiveSyncConfig(institution);
  }

  async getCourses(): Promise<DiscoveredCourse[]> {
    const useExplicitTerms = this.syncConfig.allowedTermIdSet.size > 0;

    // Engine states -> Canvas state[] enum (see CANVAS_STATE_MAP).
    const canvasStates = [
      ...new Set(this.syncConfig.allowedCourseStates.flatMap((s) => CANVAS_STATE_MAP[s])),
    ];

    logger.info("Canvas: fetching courses", {
      accountId: this.client.accountId,
      allowedCourseStates: this.syncConfig.allowedCourseStates,
      canvasStates,
      allowedTermIds: [...this.syncConfig.allowedTermIdSet],
      excludedCanvasCourseIds: [...this.syncConfig.excludedCourseIdSet],
    });

    const [canvasCourses, terms] = await Promise.all([
      // Default states cover published + draft (teachers prep before publish); completed/
      // deleted excluded. No enrollment_type filter — return every course in account scope.
      this.client.getPaginated<CanvasCourse>(
        `/accounts/${this.client.accountId}/courses`,
        { state: canvasStates },
      ),
      this.client.getTerms(),
    ]);

    // Explicit allowedTermIds sync exactly those terms (even concluded); empty falls back
    // to all currently-active terms (start/end straddle now).
    const now = new Date();
    const includedTermIds = useExplicitTerms
      ? this.syncConfig.allowedTermIdSet
      : new Set(terms.filter((t) => isActiveTerm(t, now)).map((t) => t.id.toString()));

    const activeCourses = canvasCourses.filter((c) =>
      includedTermIds.has(c.enrollment_term_id?.toString()),
    );

    // Per-institution exclude list, applied after the term filter.
    const excludedCourseIds: string[] = [];
    const includedCourses = activeCourses.filter((c) => {
      if (this.syncConfig.excludedCourseIdSet.has(c.id.toString())) {
        excludedCourseIds.push(c.id.toString());
        return false;
      }
      return true;
    });

    logger.info("Canvas: courses fetched", {
      total: canvasCourses.length,
      termMode: useExplicitTerms ? "explicit" : "active",
      includedTerms: includedTermIds.size,
      afterTermFilter: activeCourses.length,
      droppedByTermFilter: canvasCourses.length - activeCourses.length,
      afterExcludeFilter: includedCourses.length,
      droppedByExcludeFilter: excludedCourseIds.length,
    });

    if (excludedCourseIds.length > 0) {
      logger.debug("Canvas: courses dropped by exclude list", {
        excludedCourseIds,
      });
    }

    return includedCourses.map(toDiscoveredCourse);
  }

  // Fetch one course directly by id, bypassing the account listing's term/state/exclude
  // filters. Used by single-course sync so an explicit request always resolves. Null on 404.
  async getCourse(courseExternalId: string): Promise<DiscoveredCourse | null> {
    const course = await this.client.getCourse(courseExternalId);
    return course ? toDiscoveredCourse(course) : null;
  }

  // Unfiltered count of every file in the course (paginates the full listing).
  async countCourseFiles(courseExternalId: string): Promise<number> {
    const all = await this.client.getPaginated<CanvasFile>(`/courses/${courseExternalId}/files`);
    return all.length;
  }

  async getFiles(
    courseExternalId: string,
    lastSyncedAt: Date | null,
  ): Promise<DiscoveredFile[]> {
    logger.info("Canvas: fetching files", {
      courseId: courseExternalId,
      lastSyncedAt,
      // Compact view of the active filters — what the engine asked Canvas for
      // and what it'll then prune client-side.
      allowedMimeTypes: this.syncConfig.allowedMimeTypes,
      allowedExtensions: [...this.syncConfig.allowedExtensions],
      maxFileSizeBytes: this.syncConfig.maxFileSizeBytes,
      skipLockedFiles: this.syncConfig.skipLockedFiles,
      skipHiddenFiles: this.syncConfig.skipHiddenFiles,
    });

    const allFiles = await this.client.getPaginated<CanvasFile>(
      `/courses/${courseExternalId}/files`,
      {
        sort: "updated_at",
        order: "desc",
        "content_types[]": this.syncConfig.allowedMimeTypes,
      },
    );

    const afterDateFilter = lastSyncedAt
      ? allFiles.filter((f) => new Date(f.updated_at) >= lastSyncedAt)
      : allFiles;

    // Per-stage filter with drop accounting. Log file id + extension, not filename —
    // academic filenames embed student PII that would otherwise land in CloudWatch.
    const dropped: { canvasFileId: string; extension: string; reason: string }[] = [];

    const afterTypeFilter = afterDateFilter.filter((f) => {
      if (this.isSupportedFile(f)) return true;
      dropped.push({
        canvasFileId: String(f.id),
        extension: extractExtension(f.filename),
        reason: 'type-not-allowed',
      });
      return false;
    });

    const afterFlagsFilter = afterTypeFilter.filter((f) => {
      if (!this.shouldSkipForFlags(f)) return true;
      const reason = f.locked && this.syncConfig.skipLockedFiles ? 'locked' : 'hidden';
      dropped.push({
        canvasFileId: String(f.id),
        extension: extractExtension(f.filename),
        reason,
      });
      return false;
    });

    const files = afterFlagsFilter.filter((f) => {
      if (!this.exceedsSizeCap(f)) return true;
      dropped.push({
        canvasFileId: String(f.id),
        extension: extractExtension(f.filename),
        reason: `size ${f.size} > cap ${this.syncConfig.maxFileSizeBytes}`,
      });
      return false;
    });

    logger.info("Canvas: file filter summary", {
      courseId: courseExternalId,
      raw: allFiles.length,
      afterDateFilter: afterDateFilter.length,
      afterTypeFilter: afterTypeFilter.length,
      afterFlagsFilter: afterFlagsFilter.length,
      kept: files.length,
      droppedByDate: allFiles.length - afterDateFilter.length,
      droppedByType: afterDateFilter.length - afterTypeFilter.length,
      droppedByFlags: afterTypeFilter.length - afterFlagsFilter.length,
      droppedBySize: afterFlagsFilter.length - files.length,
    });

    if (dropped.length > 0) {
      // Cap the preview so courses with thousands of drops don't blow up the log line.
      logger.debug("Canvas: files dropped by filter", {
        courseId: courseExternalId,
        sample: dropped.slice(0, 50),
        totalDropped: dropped.length,
      });
    }

    return files.map(toDiscoveredFile);
  }

  async getFile(
    _courseExternalId: string,
    fileExternalId: string,
  ): Promise<DiscoveredFile | null> {
    try {
      const file = await this.client.getFile(fileExternalId);
      // No filter re-check at refresh: gates were applied at discovery, and re-checking
      // would conflate "deleted from Canvas" with "config changed" (null = file gone).
      return toDiscoveredFile(file);
    } catch (err) {
      // 404 = file deleted; null signals the caller to mark it deleted_from_source
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  private isSupportedFile(file: Pick<CanvasFile, "filename">): boolean {
    const parts = file.filename.split(".");
    if (parts.length < 2) return false;
    const ext = "." + parts.pop()!.toLowerCase();
    return this.syncConfig.allowedExtensions.has(ext);
  }

  private shouldSkipForFlags(file: Pick<CanvasFile, "locked" | "hidden">): boolean {
    if (this.syncConfig.skipLockedFiles && file.locked) return true;
    if (this.syncConfig.skipHiddenFiles && file.hidden) return true;
    return false;
  }

  private exceedsSizeCap(file: Pick<CanvasFile, "size">): boolean {
    const cap = this.syncConfig.maxFileSizeBytes;
    if (cap === null) return false;
    // file.size is a string (json-bigint). Coerce; include when missing/unparseable
    // (open-by-default rather than silently dropping normal files).
    if (file.size == null) return false;
    const sizeNum = Number(file.size);
    if (!Number.isFinite(sizeNum)) return false;
    return sizeNum > cap;
  }

  async downloadFileStream(downloadUrl: string): Promise<Readable> {
    const response = await axios.get<Readable>(downloadUrl, {
      responseType: "stream",
      timeout: 120_000,
    });
    return response.data;
  }

  isFileEligibleToReplace(
    fileExternalId: string,
    knownModifiedAt: Date,
  ): Promise<ReplaceEligibility> {
    return this.replacer.isCanvasFileEligibleToReplace(
      fileExternalId,
      knownModifiedAt,
    );
  }

  replaceFile(params: ReplaceFileParams): Promise<ReplaceResult> {
    return this.replacer.replaceFile(params);
  }

  uploadNewFile(params: UploadNewFileParams): Promise<DiscoveredFile> {
    return this.replacer.uploadNewFile(params);
  }

  supersedeFile(params: SupersedeFileParams): Promise<ReplaceResult> {
    return this.replacer.supersedeFile(params);
  }
}
