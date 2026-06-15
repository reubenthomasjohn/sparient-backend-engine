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
import { EffectiveSyncConfig, getEffectiveSyncConfig } from "../../sync/syncConfig";

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
  // Resolved once per client instance from institution.syncConfig. When
  // syncConfig is null, defaults are conservative — the 6 basic file types
  // (pdf/docx/pptx/xlsx/jpg/png) and course states ['available','unpublished'].
  // Anyone wanting more file types or stricter behavior PATCHes explicitly.
  // The wider FILE_TYPE_REGISTRY (legacy Office, OpenDocument, more images,
  // SVG, RTF, etc.) is the *available pool* — opt in via PATCH.
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

    logger.info("Canvas: fetching courses", {
      accountId: this.client.accountId,
      allowedCourseStates: this.syncConfig.allowedCourseStates,
      allowedTermIds: [...this.syncConfig.allowedTermIdSet],
      excludedCanvasCourseIds: [...this.syncConfig.excludedCourseIdSet],
    });

    const [canvasCourses, terms] = await Promise.all([
      // available = published, unpublished = draft. Both are syncable by default:
      // teachers prepping next semester want their files remediated before publish.
      // `completed` (past terms) and `deleted` are excluded. Per-institution overrides
      // come through syncConfig.allowedCourseStates. No enrollment_type filter — the
      // account-courses endpoint should return every course in scope.
      this.client.getPaginated<CanvasCourse>(
        `/accounts/${this.client.accountId}/courses`,
        { state: this.syncConfig.allowedCourseStates },
      ),
      this.client.getTerms(),
    ]);

    // Term restriction. When syncConfig.allowedTermIds is set, sync EXACTLY those terms
    // (even concluded ones) — explicit operator intent overrides the active-term heuristic.
    // When empty (default), fall back to "all currently-active terms" (start/end straddle now).
    const now = new Date();
    const includedTermIds = useExplicitTerms
      ? this.syncConfig.allowedTermIdSet
      : new Set(terms.filter((t) => isActiveTerm(t, now)).map((t) => t.id.toString()));

    const activeCourses = canvasCourses.filter((c) =>
      includedTermIds.has(c.enrollment_term_id?.toString()),
    );

    // Per-institution exclude list — applied after the term filter so the
    // logged "afterTermFilter" count remains comparable with prior behavior.
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

  // Fetch ONE course directly by its Canvas id, bypassing the account listing and its
  // term/state/exclude filters. Used by single-course sync (singleCourseId) so an explicit
  // request always resolves the course even if it wouldn't appear in the account listing
  // (e.g. a concluded term, or a course under a sub-account). Returns null if Canvas 404s.
  async getCourse(courseExternalId: string): Promise<DiscoveredCourse | null> {
    const course = await this.client.getCourse(courseExternalId);
    return course ? toDiscoveredCourse(course) : null;
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

    // Per-stage filter with structured drop accounting. We log the Canvas
    // file id (a stable handle) plus the lowercased extension instead of the
    // filename — academic Canvas filenames frequently embed student PII
    // (e.g. "doe_john_midterm.docx") and would land in CloudWatch at debug
    // level. Operators can resolve a file id back via Canvas if needed.
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
      // Cap to a reasonable preview to avoid pathological log lines on
      // courses with thousands of dropped files. Full detail is per-file
      // and only fires at debug level.
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
      // No filter re-check at refresh time. The type/locked/hidden/size
      // gates were applied at discovery; once a SourceFile row exists we
      // commit to it. Re-checking would conflate "file genuinely deleted
      // from Canvas" with "config changed mid-flight" and incorrectly mark
      // the row deleted in the latter case (the upload handler treats null
      // as "file gone from Canvas").
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
    // file.size arrives as a string (json-bigint storeAsString). Coerce, and
    // include the file if size is missing/unparseable — open-by-default for
    // Canvas API quirks rather than silently dropping normal files.
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
