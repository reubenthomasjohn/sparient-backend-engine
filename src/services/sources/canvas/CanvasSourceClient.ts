import axios from "axios";
import { Readable } from "stream";
import { Institution } from "@prisma/client";
import { CanvasClient } from "./CanvasClient";
import { CanvasFileReplacer } from "./CanvasFileReplacer";
import { toDiscoveredFile } from "./mappers";
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

// Used as a server-side filter on the Canvas API request to reduce response size.
// Canvas doesn't always assign correct MIME types, so we also check extensions
// client-side below to catch files served as application/octet-stream etc.
const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  // '.webp',
]);

function isActiveTerm(term: CanvasTerm, now: Date): boolean {
  if (term.start_at !== null && new Date(term.start_at) > now) return false;
  if (term.end_at !== null && new Date(term.end_at) < now) return false;
  return true;
}

function isSupportedFile(file: Pick<CanvasFile, "filename">): boolean {
  const parts = file.filename.split(".");
  if (parts.length < 2) return false;
  const ext = "." + parts.pop()!.toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export class CanvasSourceClient implements ISourceClient {
  private readonly client: CanvasClient;
  private readonly replacer: CanvasFileReplacer;

  constructor(institution: Institution) {
    const credentials = institution.credentials as {
      domain: string;
      account_id: string;
      api_token: string;
    };
    this.client = new CanvasClient(credentials);
    this.replacer = new CanvasFileReplacer(this.client);
  }

  async getCourses(): Promise<DiscoveredCourse[]> {
    logger.info("Canvas: fetching courses", {
      accountId: this.client.accountId,
    });

    const [canvasCourses, terms] = await Promise.all([
      this.client.getPaginated<CanvasCourse>(
        `/accounts/${this.client.accountId}/courses`,
        { state: ["available"], enrollment_type: "teacher" },
      ),
      this.client.getTerms(),
    ]);

    const now = new Date();
    const activeTermIds = new Set(
      terms.filter((t) => isActiveTerm(t, now)).map((t) => t.id),
    );

    const activeCourses = canvasCourses.filter((c) =>
      activeTermIds.has(c.enrollment_term_id),
    );

    logger.info("Canvas: courses fetched", {
      total: canvasCourses.length,
      activeTerms: activeTermIds.size,
      afterTermFilter: activeCourses.length,
    });

    return activeCourses.map((c) => ({
      externalId: c.id.toString(),
      name: c.name,
      courseCode: c.course_code ?? null,
      termId: c.enrollment_term_id ? c.enrollment_term_id.toString() : null,
    }));
  }

  async getFiles(
    courseExternalId: string,
    lastSyncedAt: Date | null,
  ): Promise<DiscoveredFile[]> {
    logger.info("Canvas: fetching files", {
      courseId: courseExternalId,
      lastSyncedAt,
    });

    const allFiles = await this.client.getPaginated<CanvasFile>(
      `/courses/${courseExternalId}/files`,
      {
        sort: "updated_at",
        order: "desc",
        "content_types[]": SUPPORTED_MIME_TYPES,
      },
    );

    const afterDateFilter = lastSyncedAt
      ? allFiles.filter((f) => new Date(f.updated_at) >= lastSyncedAt)
      : allFiles;

    const files = afterDateFilter.filter(isSupportedFile);

    logger.info("Canvas: files after filter", {
      courseId: courseExternalId,
      raw: allFiles.length,
      kept: files.length,
    });

    return files.map(toDiscoveredFile);
  }

  async getFile(
    _courseExternalId: string,
    fileExternalId: string,
  ): Promise<DiscoveredFile | null> {
    try {
      const file = await this.client.getFile(fileExternalId);
      if (!isSupportedFile(file)) return null;
      return toDiscoveredFile(file);
    } catch (err) {
      // 404 = file deleted; null signals the caller to mark it deleted_from_source
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
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
