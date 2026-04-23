/**
 * Admin institution dashboard service (TASK-08 / VALIDATION-08).
 * Tech §4.5 / §6.6, Functional §3.3.1.
 *
 * ## canvas_term_id filter policy (documented per §6.6 / TASK-08)
 * When `canvas_term_id` is provided, only courses whose `canvas_term_id` exactly matches
 * are included. Courses with a null `canvas_term_id` are NOT included in a filtered query
 * (they belong to "no term" and would require an explicit null-term opt-in). When the param
 * is absent all institution courses are included.
 *
 * ## scanned_courses definition
 * A course is counted as "scanned" when at least one of its `SourceFile` rows has a
 * non-null `lastOutcome` (i.e., at least one file has completed a remediation cycle).
 *
 * ## content_summary best-effort mapping (§0.4 gap note)
 * The schema has no dedicated "errors" vs "suggestions" column. Mappings used:
 * - errors         → sum of `found`    across issue_categories (reported issues)
 * - suggestions    → 0                 (no schema column yet; documented per §0.4)
 * - issues_fixed   → sum of `fixed`    across issue_categories
 * - marked_resolved → count of SourceFiles where `reviewAcknowledged === true`
 *   (instructor explicitly acknowledged the file's review state)
 */

import type { BatchFile, FileIssueCategory, SourceFile } from '@prisma/client';
import {
  openIssuesFromBatchCategories,
  pickLatestBatchFilePerSourceFile,
  pipelineLabel,
  rollupIssueCategories,
  type IssueCategoryRollupRow,
} from './domainDerivations';
import prisma from '../../db/client';

export type InstitutionDashboardData = {
  institution_id: string;
  scanned_courses: number;
  issues: {
    total_reported: number;
    resolved: number;
    still_open: number;
  };
  content_summary: {
    errors: number;
    suggestions: number;
    issues_fixed: number;
    marked_resolved: number;
  };
  file_pipeline: {
    total_files: number;
    files_scanned: number;
    files_with_issues: number;
    awaiting_review: number;
    fixed_by_access_hub: number;
    files_replaced_in_canvas: number;
  };
  issue_categories: IssueCategoryRollupRow[];
};

type SourceFileRow = SourceFile & {
  batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }>;
};

function isScanned(sf: SourceFile): boolean {
  return sf.lastOutcome !== null && sf.lastOutcome !== 'deleted';
}

function isFixedByAccessHub(sf: SourceFile): boolean {
  return (
    sf.lastOutcome === 'completed' ||
    sf.lastOutcome === 'completed_with_warnings'
  );
}

function isAwaitingReview(
  sf: SourceFile,
  pipeline: ReturnType<typeof pipelineLabel>,
  openIssues: number,
): boolean {
  if (sf.reviewAcknowledged) return false;
  if (pipeline !== 'terminal') return false;
  return openIssues > 0 || sf.lastOutcome === 'completed_with_warnings';
}

/**
 * Pure aggregation — used by `getInstitutionDashboard` and directly by unit tests.
 *
 * @param institutionId  Institution UUID for the response envelope
 * @param allSourceFiles All SourceFile rows (with batch snapshots) for the scoped courses
 * @param courseIdsInScope All course IDs included in this query (needed for scanned_courses)
 */
export function buildInstitutionDashboardPayload(
  institutionId: string,
  allSourceFiles: SourceFileRow[],
  courseIdsInScope: string[],
): InstitutionDashboardData {
  // Pick one latest BatchFile per SourceFile (§0.3 ordering).
  const latestBfBySfId = new Map(
    pickLatestBatchFilePerSourceFile(
      allSourceFiles.flatMap((sf) =>
        sf.batchFiles.map((bf) => ({ ...bf, sourceFileId: sf.id })),
      ),
    ).map((bf) => [bf.sourceFileId, bf]),
  );

  type FileRow = {
    sf: SourceFile;
    openIssues: number;
    pipeline: ReturnType<typeof pipelineLabel>;
  };

  const fileRows: FileRow[] = allSourceFiles.map((sf) => {
    const latestBf = latestBfBySfId.get(sf.id) ?? null;
    const cats = latestBf?.issueCategories ?? [];
    const openIssues = openIssuesFromBatchCategories(cats);
    const pipeline = pipelineLabel({
      discoveredModifiedAt: sf.discoveredModifiedAt,
      s3SourceModifiedAt: sf.s3SourceModifiedAt,
      batchedModifiedAt: sf.batchedModifiedAt,
      lastOutcome: sf.lastOutcome,
    });
    return { sf, openIssues, pipeline };
  });

  // issue_categories — rollup across latest batch file per source file
  const latestBfsForRollup = [...latestBfBySfId.values()];
  const issue_categories = rollupIssueCategories(
    latestBfsForRollup.map((bf) => ({ issueCategories: bf.issueCategories })),
  );

  // issues
  const total_reported = issue_categories.reduce((s, r) => s + r.found, 0);
  const resolved_issues = issue_categories.reduce((s, r) => s + r.fixed, 0);
  const still_open = issue_categories.reduce((s, r) => s + r.remaining, 0);

  // content_summary (best-effort per §0.4 — see module header)
  const marked_resolved = fileRows.filter((r) => r.sf.reviewAcknowledged).length;

  // file_pipeline
  const total_files = fileRows.length;
  const files_scanned = fileRows.filter((r) => isScanned(r.sf)).length;
  const files_with_issues = fileRows.filter((r) => r.openIssues > 0).length;
  const awaiting_review = fileRows.filter((r) =>
    isAwaitingReview(r.sf, r.pipeline, r.openIssues),
  ).length;
  const fixed_by_access_hub = fileRows.filter((r) => isFixedByAccessHub(r.sf)).length;
  const files_replaced_in_canvas = fileRows.filter(
    (r) => r.sf.writebackState === 'written',
  ).length;

  // scanned_courses — courses with at least one file that has been through a scan cycle
  const scannedCourseIds = new Set(
    fileRows
      .filter((r) => isScanned(r.sf))
      .map((r) => r.sf.courseId),
  );
  const scanned_courses = scannedCourseIds.size;

  // Suppress unused variable (courseIdsInScope available for future use, e.g. total course count)
  void courseIdsInScope;

  return {
    institution_id: institutionId,
    scanned_courses,
    issues: {
      total_reported,
      resolved: resolved_issues,
      still_open,
    },
    content_summary: {
      errors: total_reported,
      suggestions: 0,
      issues_fixed: resolved_issues,
      marked_resolved,
    },
    file_pipeline: {
      total_files,
      files_scanned,
      files_with_issues,
      awaiting_review,
      fixed_by_access_hub,
      files_replaced_in_canvas,
    },
    issue_categories,
  };
}

export async function getInstitutionDashboard(
  institutionId: string,
  canvasTermId?: string,
): Promise<InstitutionDashboardData> {
  // Load courses in scope (used to get courseIds + for scanned_courses denominator)
  const courses = await prisma.course.findMany({
    where: {
      institutionId,
      ...(canvasTermId ? { canvasTermId } : {}),
    },
    select: { id: true },
  });

  const courseIds = courses.map((c) => c.id);

  if (courseIds.length === 0) {
    return buildInstitutionDashboardPayload(institutionId, [], []);
  }

  // Load all source files for scoped courses in a single query
  const sourceFiles = await prisma.sourceFile.findMany({
    where: { courseId: { in: courseIds } },
    include: {
      batchFiles: {
        include: { issueCategories: true },
      },
    },
  });

  return buildInstitutionDashboardPayload(institutionId, sourceFiles, courseIds);
}
