import type {
  BatchFile,
  Course,
  FileIssueCategory,
  Institution,
  SourceFile,
} from '@prisma/client';
import {
  openIssuesFromBatchCategories,
  pipelineLabel,
  rollupIssueCategories,
  selectLatestBatchFileForSnapshot,
  type IssueCategoryRollupRow,
} from './domainDerivations';
import prisma from '../../db/client';

export type CourseDashboardData = {
  canvas_course_id: string;
  issues: {
    total_reported: number;
    resolved: number;
    still_open: number;
  };
  counts: {
    total_files: number;
    files_scanned: number;
    files_with_issues: number;
    awaiting_review: number;
    fixed_by_access_hub: number;
    files_replaced_in_canvas: number;
  };
  high_impact_files: Array<{
    source_file_id: string;
    canvas_file_id: string;
    display_name: string;
    open_issues: number;
  }>;
  issues_by_file_type: Array<{
    file_type: string;
    files: number;
    issues: number;
  }>;
  issue_categories: IssueCategoryRollupRow[];
};

export type SourceFileWithBatchSnapshots = SourceFile & {
  batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }>;
};

/** File extension (uppercase) or MIME subtype for grouping (functional §3.2). */
export function fileTypeLabel(
  sf: Pick<SourceFile, 'fileName' | 'mimeType'>,
): string {
  const base = sf.fileName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot !== -1 && dot < base.length - 1) {
    return base.slice(dot + 1).toUpperCase().slice(0, 32);
  }
  const mime = sf.mimeType.includes('/')
    ? sf.mimeType.split('/').pop()
    : sf.mimeType;
  return (mime ?? 'OTHER').toUpperCase().slice(0, 32);
}

function isScannedFile(sf: SourceFile): boolean {
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
 * Pure aggregation for tests and for `getCourseDashboardForCourse` (TASK-04 / §4.1).
 */
export function buildCourseDashboardPayload(
  course: Pick<Course, 'canvasCourseId'>,
  sourceFiles: SourceFileWithBatchSnapshots[],
): CourseDashboardData {
  type Row = {
    sf: SourceFile;
    latestBf: (BatchFile & { issueCategories: FileIssueCategory[] }) | null;
    open_issues: number;
    pipeline: ReturnType<typeof pipelineLabel>;
  };

  const rows: Row[] = [];
  for (const sf of sourceFiles) {
    const latestBf = selectLatestBatchFileForSnapshot(sf.batchFiles);
    const cats = latestBf?.issueCategories ?? [];
    const open_issues = openIssuesFromBatchCategories(cats);
    const pipeline = pipelineLabel({
      discoveredModifiedAt: sf.discoveredModifiedAt,
      s3SourceModifiedAt: sf.s3SourceModifiedAt,
      batchedModifiedAt: sf.batchedModifiedAt,
      lastOutcome: sf.lastOutcome,
    });
    rows.push({ sf, latestBf, open_issues, pipeline });
  }

  const rollupInputs = rows
    .filter((r) => r.latestBf !== null)
    .map((r) => ({ issueCategories: r.latestBf!.issueCategories }));

  const issue_categories = rollupIssueCategories(rollupInputs);

  const total_reported = issue_categories.reduce((s, r) => s + r.found, 0);
  const resolved = issue_categories.reduce((s, r) => s + r.fixed, 0);
  const still_open = issue_categories.reduce((s, r) => s + r.remaining, 0);

  const high_impact_files = rows
    .filter((r) => r.open_issues > 0)
    .map((r) => ({
      source_file_id: r.sf.id,
      canvas_file_id: r.sf.canvasFileId,
      display_name: r.sf.displayName,
      open_issues: r.open_issues,
    }))
    .sort((a, b) => {
      if (b.open_issues !== a.open_issues) return b.open_issues - a.open_issues;
      return a.display_name.localeCompare(b.display_name);
    });

  const typeMap = new Map<string, { fileIds: Set<string>; issues: number }>();
  for (const r of rows) {
    if (r.open_issues <= 0) continue;
    const label = fileTypeLabel(r.sf);
    const cur = typeMap.get(label) ?? { fileIds: new Set<string>(), issues: 0 };
    cur.fileIds.add(r.sf.id);
    cur.issues += r.open_issues;
    typeMap.set(label, cur);
  }
  const issues_by_file_type = [...typeMap.entries()]
    .map(([file_type, v]) => ({
      file_type,
      files: v.fileIds.size,
      issues: v.issues,
    }))
    .sort((a, b) => a.file_type.localeCompare(b.file_type));

  const total_files = sourceFiles.length;
  const files_scanned = rows.filter((r) => isScannedFile(r.sf)).length;
  const files_with_issues = rows.filter((r) => r.open_issues > 0).length;
  const awaiting_review = rows.filter((r) =>
    isAwaitingReview(r.sf, r.pipeline, r.open_issues),
  ).length;
  const fixed_by_access_hub = rows.filter((r) =>
    isFixedByAccessHub(r.sf),
  ).length;
  const files_replaced_in_canvas = rows.filter(
    (r) => r.sf.writebackState === 'written',
  ).length;

  return {
    canvas_course_id: course.canvasCourseId,
    issues: {
      total_reported,
      resolved,
      still_open,
    },
    counts: {
      total_files,
      files_scanned,
      files_with_issues,
      awaiting_review,
      fixed_by_access_hub,
      files_replaced_in_canvas,
    },
    high_impact_files,
    issues_by_file_type,
    issue_categories,
  };
}

export async function getCourseDashboardForCourse(
  course: Course,
): Promise<CourseDashboardData> {
  const sourceFiles = await prisma.sourceFile.findMany({
    where: { courseId: course.id },
    include: {
      batchFiles: {
        include: { issueCategories: true },
      },
    },
  });

  return buildCourseDashboardPayload(course, sourceFiles);
}
