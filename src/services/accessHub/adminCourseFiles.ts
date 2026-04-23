/**
 * Admin cross-course files list (TASK-10 / VALIDATION-10).
 * Tech §4.7; Functional §3.3.3.
 *
 * Extends the course-files-list (TASK-05) row shape with:
 *   - `canvas_course_id` — from the owning Course
 *   - `course_name`      — from the owning Course
 *   - `account_name`     — Institution.name (same pattern as TASK-08/09)
 *
 * Additional query parameters beyond TASK-05:
 *   - `canvas_term_id`   — filter courses by term (exact match, empty string ignored)
 *   - `canvas_course_id` — restrict to a single course inside the institution
 *
 * Filters, sort, pagination, and status semantics are identical to TASK-05.
 *
 * ## Effective writeback
 * Computed per-course (Course.writebackOptIn ?? Institution.writebackOptIn) because
 * each course in the cross-course list may independently override the institution default.
 *
 * ## Forbidden fields
 * `comment` and enrollment fields are never returned on any item.
 */

import { z } from 'zod';
import type { Institution } from '@prisma/client';
import prisma from '../../db/client';
import { effectiveWritebackOptIn } from './domainDerivations';
import {
  buildFileListItem,
  matchesStatusFilter,
  type FileListItem,
  type FileListQuery,
  type SourceFileForList,
} from './courseFilesList';
import { Errors } from '../../utils/errors';

// ─── Extended query schema ────────────────────────────────────────────────────

const STATUS_VALUES = ['all', 'in_progress', 'complete', 'failed'] as const;
const SORT_VALUES = [
  'open_issues_desc',
  'display_name_asc',
  'display_name_desc',
  'last_updated_desc',
] as const;

export const adminFilesQuerySchema = z.object({
  canvas_term_id: z.string().optional(),
  canvas_course_id: z.string().optional(),
  q: z.string().optional(),
  status: z.enum(STATUS_VALUES).default('all'),
  hide_replaced_in_canvas: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  sort: z.enum(SORT_VALUES).default('open_issues_desc'),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1, 'page_size must be >= 1')
    .max(100, 'page_size must be <= 100')
    .default(20),
});

export type AdminFilesQuery = z.infer<typeof adminFilesQuerySchema>;

export function parseAdminFilesQuery(
  raw: Record<string, unknown>,
): AdminFilesQuery {
  const result = adminFilesQuerySchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw Errors.badRequest(msg);
  }
  return result.data;
}

// ─── Extended item type ───────────────────────────────────────────────────────

export type AdminFileItem = FileListItem & {
  canvas_course_id: string;
  course_name: string;
  account_name: string;
};

export type AdminCourseFilesData = {
  items: AdminFileItem[];
  page: { number: number; size: number; total_items: number };
};

// ─── Service entry point ──────────────────────────────────────────────────────

export async function getAdminCourseFileList(
  institution: Institution,
  query: AdminFilesQuery,
): Promise<AdminCourseFilesData> {
  // Build course WHERE for institution boundary + optional filters
  const courseWhere = {
    institutionId: institution.id,
    ...(query.canvas_term_id?.trim()
      ? { canvasTermId: query.canvas_term_id.trim() }
      : {}),
    ...(query.canvas_course_id?.trim()
      ? { canvasCourseId: query.canvas_course_id.trim() }
      : {}),
  };

  // Fetch matching courses (minimal select — we need id, canvasCourseId, name, writebackOptIn)
  const courses = await prisma.course.findMany({
    where: courseWhere,
    select: {
      id: true,
      canvasCourseId: true,
      name: true,
      writebackOptIn: true,
    },
  });

  if (courses.length === 0) {
    return {
      items: [],
      page: { number: query.page, size: 0, total_items: 0 },
    };
  }

  const courseIdSet = new Set(courses.map((c) => c.id));
  const courseById = new Map(courses.map((c) => [c.id, c]));

  // Fetch all SourceFiles for those courses in one query (with nested batch data)
  const sourceFiles = await prisma.sourceFile.findMany({
    where: {
      courseId: { in: courses.map((c) => c.id) },
      ...(query.q?.trim()
        ? {
            OR: [
              { displayName: { contains: query.q.trim(), mode: 'insensitive' } },
              { fileName: { contains: query.q.trim(), mode: 'insensitive' } },
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

  // Map to extended items (per-course effective writeback)
  type InternalAdminItem = ReturnType<typeof buildFileListItem> & {
    canvas_course_id: string;
    course_name: string;
    account_name: string;
  };

  const internalItems: InternalAdminItem[] = [];

  for (const sf of sourceFiles) {
    if (!courseIdSet.has(sf.courseId)) continue; // should not happen but guard
    const course = courseById.get(sf.courseId)!;

    const effectiveWriteback = effectiveWritebackOptIn({
      institutionWritebackOptIn: institution.writebackOptIn,
      courseWritebackOptIn: course.writebackOptIn,
    });

    const base = buildFileListItem(sf as SourceFileForList, effectiveWriteback);

    internalItems.push({
      ...base,
      canvas_course_id: course.canvasCourseId,
      course_name: course.name,
      account_name: institution.name,
    });
  }

  // Status filter
  let filtered = query.status !== 'all'
    ? internalItems.filter((item) =>
        matchesStatusFilter(item._pipeline, query.status as FileListQuery['status']),
      )
    : internalItems;

  // hide_replaced_in_canvas
  if (query.hide_replaced_in_canvas) {
    filtered = filtered.filter(
      (item) => item.canvas_replacement.state !== 'replaced',
    );
  }

  // Sort (same comparators as TASK-05 courseFilesList.sortItems)
  const sort = query.sort as FileListQuery['sort'];
  filtered.sort((a, b) => {
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

  // Paginate
  const total_items = filtered.length;
  const { page, page_size } = query;
  const start = (page - 1) * page_size;
  const pageSlice = filtered.slice(start, start + page_size);

  // Strip internal fields
  const publicItems: AdminFileItem[] = pageSlice.map(
    ({ _pipeline, _openIssues, _lastUpdatedMs, ...pub }) => pub as AdminFileItem,
  );

  return {
    items: publicItems,
    page: { number: page, size: pageSlice.length, total_items },
  };
}
