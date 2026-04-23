/**
 * Course files list service (TASK-05 / VALIDATION-05).
 * Tech §4.2, Functional §3.1.1.
 *
 * ## Status filter mapping (documented here per spec)
 *
 * | API `status` | Derived pipeline / outcome |
 * |---|---|
 * | `all`        | no filter |
 * | `in_progress`| pipeline ∈ `needs_upload`, `needs_batching`, `in_flight` |
 * | `complete`   | pipeline === `terminal` (last_outcome completed or completed_with_warnings) |
 * | `failed`     | last_outcome ∈ `failed`, `permanently_failed` |
 *
 * ## Sort options
 * | `sort` param        | Order |
 * |---|---|
 * | `open_issues_desc`  | open_issues DESC, display_name ASC (default) |
 * | `display_name_asc`  | display_name ASC |
 * | `display_name_desc` | display_name DESC |
 * | `last_updated_desc` | last_updated DESC |
 *
 * ## last_updated
 * The greater of `SourceFile.updatedAt` and the latest BatchFile `createdAt`.
 *
 * ## file_type
 * Normalised enum from extension or MIME type.
 * One of: pdf | image | word | excel | powerpoint | video | other
 */

import { z } from 'zod';
import type {
  BatchFile,
  Course,
  FileIssueCategory,
  Institution,
  SourceFile,
} from '@prisma/client';
import prisma from '../../db/client';
import {
  deriveCanvasReplacementState,
  effectiveWritebackOptIn,
  openIssuesFromBatchCategories,
  pickLatestBatchFilePerSourceFile,
  pipelineLabel,
  type CanvasReplacementState,
  type PipelineLabel,
} from './domainDerivations';
import { Errors } from '../../utils/errors';

// ─── Query schema ────────────────────────────────────────────────────────────

const STATUS_VALUES = ['all', 'in_progress', 'complete', 'failed'] as const;
const SORT_VALUES = [
  'open_issues_desc',
  'display_name_asc',
  'display_name_desc',
  'last_updated_desc',
] as const;

export const fileListQuerySchema = z.object({
  q: z.string().optional(),
  status: z.enum(STATUS_VALUES).default('all'),
  hide_replaced_in_canvas: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  sort: z.enum(SORT_VALUES).default('open_issues_desc'),
  page: z.coerce
    .number()
    .int()
    .min(1, 'page must be >= 1')
    .default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1, 'page_size must be >= 1')
    .max(100, 'page_size must be <= 100')
    .default(20),
});

export type FileListQuery = z.infer<typeof fileListQuerySchema>;

export function parseFileListQuery(raw: Record<string, unknown>): FileListQuery {
  const result = fileListQuerySchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw Errors.badRequest(msg);
  }
  return result.data;
}

// ─── File type normalisation (§4.2 enum) ─────────────────────────────────────

export type NormalisedFileType =
  | 'pdf'
  | 'image'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'video'
  | 'other';

const EXT_MAP: Record<string, NormalisedFileType> = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', tiff: 'image', tif: 'image',
  doc: 'word', docx: 'word', odt: 'word',
  xls: 'excel', xlsx: 'excel', ods: 'excel', csv: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', odp: 'powerpoint',
  mp4: 'video', mov: 'video', avi: 'video', webm: 'video',
  mkv: 'video', flv: 'video', wmv: 'video',
};

const MIME_PREFIX_MAP: [string, NormalisedFileType][] = [
  ['application/pdf', 'pdf'],
  ['image/', 'image'],
  ['video/', 'video'],
  ['application/msword', 'word'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml', 'word'],
  ['application/vnd.oasis.opendocument.text', 'word'],
  ['application/vnd.ms-excel', 'excel'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml', 'excel'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'excel'],
  ['application/vnd.ms-powerpoint', 'powerpoint'],
  ['application/vnd.openxmlformats-officedocument.presentationml', 'powerpoint'],
  ['application/vnd.oasis.opendocument.presentation', 'powerpoint'],
];

export function normalisedFileType(
  fileName: string,
  mimeType: string,
): NormalisedFileType {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot !== -1) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (EXT_MAP[ext]) return EXT_MAP[ext]!;
  }
  for (const [prefix, type] of MIME_PREFIX_MAP) {
    if (mimeType.startsWith(prefix)) return type;
  }
  return 'other';
}

// ─── Status summary text ──────────────────────────────────────────────────────

export function buildStatusSummary(
  pipeline: PipelineLabel,
  openIssues: number,
  totalFound: number,
): string {
  switch (pipeline) {
    case 'deleted': return 'File deleted from Canvas';
    case 'needs_upload': return 'Pending upload';
    case 'needs_batching': return 'Pending scan';
    case 'in_flight': return 'Scan in progress';
    case 'terminal': {
      if (openIssues > 0) {
        return `${openIssues} issue${openIssues === 1 ? '' : 's'} remaining`;
      }
      if (totalFound > 0) return 'All issues resolved';
      return 'No accessibility issues detected';
    }
    default: return 'Status unknown';
  }
}

// ─── Status filter ────────────────────────────────────────────────────────────

export function matchesStatusFilter(
  pipeline: PipelineLabel,
  filter: FileListQuery['status'],
): boolean {
  if (filter === 'all') return true;
  if (filter === 'in_progress') {
    return (
      pipeline === 'needs_upload' ||
      pipeline === 'needs_batching' ||
      pipeline === 'in_flight'
    );
  }
  if (filter === 'complete') return pipeline === 'terminal';
  if (filter === 'failed') return pipeline === 'unknown';
  return true;
}

// ─── last_updated derivation ──────────────────────────────────────────────────

function lastUpdated(
  sf: Pick<SourceFile, 'updatedAt'>,
  latestBf: { createdAt: Date } | null,
): Date {
  const sfMs = sf.updatedAt.getTime();
  const bfMs = latestBf?.createdAt.getTime() ?? 0;
  return new Date(Math.max(sfMs, bfMs));
}

// ─── Per-row item shape ───────────────────────────────────────────────────────

export type FileListItem = {
  source_file_id: string;
  canvas_file_id: string;
  display_name: string;
  file_name: string;
  file_type: NormalisedFileType;
  mime_type: string;
  last_updated: string;
  open_issues: number;
  review_acknowledged: boolean;
  status: {
    pipeline: PipelineLabel;
    last_outcome: string | null;
    summary: string;
  };
  canvas_replacement: {
    state: CanvasReplacementState;
    writeback_state: string | null;
  };
};

export type SourceFileForList = SourceFile & {
  batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }>;
};

export function buildFileListItem(
  sf: SourceFileForList,
  effectiveWriteback: boolean,
): FileListItem & {
  /** Not exposed on API; used internally for filter/sort then stripped. */
  _pipeline: PipelineLabel;
  _openIssues: number;
  _lastUpdatedMs: number;
} {
  const allBatchFiles = sf.batchFiles;
  const latestBf =
    allBatchFiles.length === 0
      ? null
      : pickLatestBatchFilePerSourceFile(
          allBatchFiles.map((b) => ({
            ...b,
            sourceFileId: b.sourceFileId,
          })),
        ).find(() => true) ?? null;

  const cats = latestBf?.issueCategories ?? [];
  const openIssues = openIssuesFromBatchCategories(cats);
  const totalFound = cats.reduce((s, c) => s + c.found, 0);

  const pipeline = pipelineLabel({
    discoveredModifiedAt: sf.discoveredModifiedAt,
    s3SourceModifiedAt: sf.s3SourceModifiedAt,
    batchedModifiedAt: sf.batchedModifiedAt,
    lastOutcome: sf.lastOutcome,
  });

  const replacement = deriveCanvasReplacementState(
    { writebackState: sf.writebackState },
    latestBf,
    effectiveWriteback,
  );

  const lu = lastUpdated(sf, latestBf);

  return {
    source_file_id: sf.id,
    canvas_file_id: sf.canvasFileId,
    display_name: sf.displayName,
    file_name: sf.fileName,
    file_type: normalisedFileType(sf.fileName, sf.mimeType),
    mime_type: sf.mimeType,
    last_updated: lu.toISOString(),
    open_issues: openIssues,
    review_acknowledged: sf.reviewAcknowledged,
    status: {
      pipeline,
      last_outcome: sf.lastOutcome ?? null,
      summary: buildStatusSummary(pipeline, openIssues, totalFound),
    },
    canvas_replacement: {
      state: replacement.state,
      writeback_state: replacement.writebackState ?? null,
    },
    _pipeline: pipeline,
    _openIssues: openIssues,
    _lastUpdatedMs: lu.getTime(),
  };
}

// ─── Sort comparator ──────────────────────────────────────────────────────────

type InternalItem = ReturnType<typeof buildFileListItem>;

function sortItems(items: InternalItem[], sort: FileListQuery['sort']): void {
  items.sort((a, b) => {
    switch (sort) {
      case 'open_issues_desc': {
        const diff = b._openIssues - a._openIssues;
        return diff !== 0 ? diff : a.display_name.localeCompare(b.display_name);
      }
      case 'display_name_asc':
        return a.display_name.localeCompare(b.display_name);
      case 'display_name_desc':
        return b.display_name.localeCompare(a.display_name);
      case 'last_updated_desc': {
        const diff = b._lastUpdatedMs - a._lastUpdatedMs;
        return diff !== 0 ? diff : a.display_name.localeCompare(b.display_name);
      }
    }
  });
}

// ─── Public response types ────────────────────────────────────────────────────

export type CourseFileListData = {
  items: FileListItem[];
  page: { number: number; size: number; total_items: number };
};

// ─── Main service entry point ─────────────────────────────────────────────────

export async function getCourseFileList(
  course: Course,
  institution: Institution,
  query: FileListQuery,
): Promise<CourseFileListData> {
  const sourceFiles = await prisma.sourceFile.findMany({
    where: {
      courseId: course.id,
      ...(query.q
        ? {
            OR: [
              { displayName: { contains: query.q, mode: 'insensitive' } },
              { fileName: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      batchFiles: {
        include: { issueCategories: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const effectiveWriteback = effectiveWritebackOptIn({
    institutionWritebackOptIn: institution.writebackOptIn,
    courseWritebackOptIn: course.writebackOptIn,
  });

  let items = sourceFiles.map((sf) =>
    buildFileListItem(sf as SourceFileForList, effectiveWriteback),
  );

  // Status filter
  if (query.status !== 'all') {
    items = items.filter((item) =>
      matchesStatusFilter(item._pipeline, query.status),
    );
  }

  // hide_replaced_in_canvas
  if (query.hide_replaced_in_canvas) {
    items = items.filter((item) => item.canvas_replacement.state !== 'replaced');
  }

  // Sort
  sortItems(items, query.sort);

  // Paginate
  const total_items = items.length;
  const { page, page_size } = query;
  const start = (page - 1) * page_size;
  const pageItems = items.slice(start, start + page_size);

  // Strip internal fields before returning
  const publicItems: FileListItem[] = pageItems.map(
    ({ _pipeline, _openIssues, _lastUpdatedMs, ...pub }) => pub,
  );

  return {
    items: publicItems,
    page: { number: page, size: pageItems.length, total_items },
  };
}
