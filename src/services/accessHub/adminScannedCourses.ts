/**
 * Admin scanned courses list (TASK-09 / VALIDATION-09).
 * Tech §4.6; Functional §3.3.2.
 *
 * ## Scan timestamp derivation (documented per §4.6 hint)
 *
 * - `initial_scan_at` → minimum `Batch.createdAt` where `isInitialSync = true` for the course.
 *   Falls back to null if no initial-sync batch exists.
 * - `last_scanned_at` → maximum `Batch.completedAt` across terminal batches
 *   (status in `completed`, `completed_with_warnings`, `failed`, `cancelled`) for the course.
 *   Null when no terminal batch exists.
 *
 * ## Counts derivation (best-effort from available schema; §0.4 note)
 *
 * | Field            | Source                                                             |
 * |------------------|--------------------------------------------------------------------|
 * | errors           | Sum `Batch.totalIssuesFound` across all terminal batches           |
 * | suggestions      | 0 — no dedicated schema column (§0.4 gap)                         |
 * | content_scanned  | SourceFile count with `lastOutcome` IS NOT NULL (scanned ≥ once)  |
 * | content_fixed    | SourceFile count with `lastOutcome` IN (completed, …_with_warnings)|
 * | content_resolved | SourceFile count with `reviewAcknowledged = true`                 |
 * | files_scanned    | Same as content_scanned                                           |
 *
 * ## account_name
 * The Institution.name field serves as the Canvas "account name" in this API surface.
 * No separate account table exists in the current schema.
 *
 * ## Forbidden fields
 * `total_students`, `enrollment`, `score_percent` are not returned on any item.
 */

import { z } from 'zod';
import type { BatchStatus, Institution } from '@prisma/client';
import prisma from '../../db/client';
import { Errors } from '../../utils/errors';

// ─── Query schema ────────────────────────────────────────────────────────────

export const scannedCoursesQuerySchema = z.object({
  canvas_term_id: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1, 'page_size must be >= 1')
    .max(100, 'page_size must be <= 100')
    .default(20),
});

export type ScannedCoursesQuery = z.infer<typeof scannedCoursesQuerySchema>;

export function parseScannedCoursesQuery(
  raw: Record<string, unknown>,
): ScannedCoursesQuery {
  const result = scannedCoursesQuerySchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw Errors.badRequest(msg);
  }
  return result.data;
}

// ─── Response types ───────────────────────────────────────────────────────────

export type ScannedCourseItem = {
  canvas_course_id: string;
  course_name: string;
  course_code: string | null;
  account_name: string;
  institution_id: string;
  initial_scan_at: string | null;
  last_scanned_at: string | null;
  counts: {
    errors: number;
    suggestions: number;
    content_scanned: number;
    content_fixed: number;
    content_resolved: number;
    files_scanned: number;
  };
};

export type ScannedCoursesData = {
  items: ScannedCourseItem[];
  page: { number: number; size: number; total_items: number };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES: BatchStatus[] = [
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
];

// ─── Service entry point ──────────────────────────────────────────────────────

export async function getScannedCoursesList(
  institution: Institution,
  query: ScannedCoursesQuery,
): Promise<ScannedCoursesData> {
  const { page, page_size } = query;

  // Build shared WHERE clause for course search
  const courseWhere = {
    institutionId: institution.id,
    ...(query.canvas_term_id?.trim()
      ? { canvasTermId: query.canvas_term_id.trim() }
      : {}),
    ...(query.q?.trim()
      ? {
          OR: [
            { name: { contains: query.q.trim(), mode: 'insensitive' as const } },
            { courseCode: { contains: query.q.trim(), mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  // Total count for pagination metadata
  const total_items = await prisma.course.count({ where: courseWhere });

  if (total_items === 0) {
    return {
      items: [],
      page: { number: page, size: 0, total_items: 0 },
    };
  }

  // Page of courses
  const courses = await prisma.course.findMany({
    where: courseWhere,
    orderBy: [{ name: 'asc' }, { canvasCourseId: 'asc' }],
    skip: (page - 1) * page_size,
    take: page_size,
    select: {
      id: true,
      canvasCourseId: true,
      name: true,
      courseCode: true,
      institutionId: true,
    },
  });

  if (courses.length === 0) {
    return {
      items: [],
      page: { number: page, size: 0, total_items },
    };
  }

  const courseIds = courses.map((c) => c.id);

  // Batch data for these courses
  const batches = await prisma.batch.findMany({
    where: { courseId: { in: courseIds } },
    select: {
      courseId: true,
      isInitialSync: true,
      status: true,
      createdAt: true,
      completedAt: true,
      totalIssuesFound: true,
    },
  });

  // SourceFile counts for these courses (minimal select)
  const sourceFiles = await prisma.sourceFile.findMany({
    where: { courseId: { in: courseIds } },
    select: {
      courseId: true,
      lastOutcome: true,
      reviewAcknowledged: true,
    },
  });

  // Group by courseId
  const batchesByCourse = new Map<string, typeof batches>();
  for (const b of batches) {
    const list = batchesByCourse.get(b.courseId) ?? [];
    list.push(b);
    batchesByCourse.set(b.courseId, list);
  }

  const filesByCourse = new Map<string, typeof sourceFiles>();
  for (const sf of sourceFiles) {
    const list = filesByCourse.get(sf.courseId) ?? [];
    list.push(sf);
    filesByCourse.set(sf.courseId, list);
  }

  // Build items
  const items: ScannedCourseItem[] = courses.map((course) => {
    const courseBatches = batchesByCourse.get(course.id) ?? [];
    const courseFiles = filesByCourse.get(course.id) ?? [];

    // initial_scan_at: min createdAt of isInitialSync batches
    const initialBatches = courseBatches.filter((b) => b.isInitialSync);
    const initial_scan_at =
      initialBatches.length > 0
        ? initialBatches
            .reduce((min, b) =>
              b.createdAt.getTime() < min.createdAt.getTime() ? b : min,
            )
            .createdAt.toISOString()
        : null;

    // last_scanned_at: max completedAt of terminal batches
    const terminalBatches = courseBatches.filter(
      (b) => TERMINAL_STATUSES.includes(b.status) && b.completedAt !== null,
    );
    const last_scanned_at =
      terminalBatches.length > 0
        ? terminalBatches
            .reduce((max, b) =>
              b.completedAt!.getTime() > max.completedAt!.getTime() ? b : max,
            )
            .completedAt!.toISOString()
        : null;

    // counts
    const terminalBatchesWithIssues = courseBatches.filter((b) =>
      TERMINAL_STATUSES.includes(b.status),
    );
    const errors = terminalBatchesWithIssues.reduce(
      (s, b) => s + (b.totalIssuesFound ?? 0),
      0,
    );

    const content_scanned = courseFiles.filter(
      (sf) => sf.lastOutcome !== null,
    ).length;

    const content_fixed = courseFiles.filter(
      (sf) =>
        sf.lastOutcome === 'completed' ||
        sf.lastOutcome === 'completed_with_warnings',
    ).length;

    const content_resolved = courseFiles.filter(
      (sf) => sf.reviewAcknowledged,
    ).length;

    return {
      canvas_course_id: course.canvasCourseId,
      course_name: course.name,
      course_code: course.courseCode,
      account_name: institution.name,
      institution_id: course.institutionId,
      initial_scan_at,
      last_scanned_at,
      counts: {
        errors,
        suggestions: 0,
        content_scanned,
        content_fixed,
        content_resolved,
        files_scanned: content_scanned,
      },
    };
  });

  return {
    items,
    page: { number: page, size: items.length, total_items },
  };
}
