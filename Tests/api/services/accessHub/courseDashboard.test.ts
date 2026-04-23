import { describe, it, expect } from 'vitest';
import type { BatchFile, FileIssueCategory, SourceFile } from '@prisma/client';
import {
  buildCourseDashboardPayload,
  fileTypeLabel,
  type SourceFileWithBatchSnapshots,
} from '@/services/accessHub/courseDashboard';

function cat(
  partial: Pick<FileIssueCategory, 'category' | 'found' | 'fixed' | 'remaining'> &
    Partial<FileIssueCategory>,
): FileIssueCategory {
  return {
    id: partial.id ?? `cat-${partial.category}`,
    batchFileId: partial.batchFileId ?? 'bf-1',
    category: partial.category,
    found: partial.found,
    fixed: partial.fixed,
    remaining: partial.remaining,
  };
}

function batchFile(
  p: Pick<BatchFile, 'id' | 'sourceFileId' | 'createdAt'> &
    Partial<BatchFile> & { issueCategories: FileIssueCategory[] },
): BatchFile & { issueCategories: FileIssueCategory[] } {
  const now = new Date();
  return {
    batchId: p.batchId ?? 'batch-1',
    canvasFileId: p.canvasFileId ?? 'cf',
    s3SourceKey: p.s3SourceKey ?? 'key',
    sourceModifiedAt: p.sourceModifiedAt ?? now,
    connectivoState: p.connectivoState ?? null,
    qualityLabel: p.qualityLabel ?? null,
    remediatedS3Key: p.remediatedS3Key ?? null,
    remediatedS3Bucket: p.remediatedS3Bucket ?? null,
    totalPages: p.totalPages ?? null,
    processingTimeSecs: p.processingTimeSecs ?? null,
    verapdfErrors: p.verapdfErrors ?? null,
    verapdfWarnings: p.verapdfWarnings ?? null,
    errorMessage: p.errorMessage ?? null,
    updatedAt: p.updatedAt ?? now,
    ...p,
  } as BatchFile & { issueCategories: FileIssueCategory[] };
}

function sourceFile(
  p: Pick<SourceFile, 'id' | 'courseId' | 'canvasFileId'> &
    Partial<SourceFile> & {
      batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }>;
    },
): SourceFileWithBatchSnapshots {
  const t = new Date('2026-01-01T00:00:00Z');
  return {
    displayName: p.displayName ?? 'Doc',
    fileName: p.fileName ?? 'doc.pdf',
    mimeType: p.mimeType ?? 'application/pdf',
    sizeBytes: p.sizeBytes ?? null,
    discoveredModifiedAt: p.discoveredModifiedAt ?? t,
    s3SourceKey: p.s3SourceKey ?? 'k',
    s3SourceBucket: p.s3SourceBucket ?? 'b',
    s3SourceModifiedAt: p.s3SourceModifiedAt ?? t,
    batchedModifiedAt: p.batchedModifiedAt ?? t,
    lastOutcome: p.lastOutcome ?? 'completed',
    lastFailureReason: p.lastFailureReason ?? null,
    retryCount: p.retryCount ?? 0,
    maxRetries: p.maxRetries ?? 3,
    nextRetryAt: p.nextRetryAt ?? null,
    writebackState: p.writebackState ?? null,
    lastWritebackModifiedAt: p.lastWritebackModifiedAt ?? null,
    reviewAcknowledged: p.reviewAcknowledged ?? false,
    createdAt: p.createdAt ?? t,
    updatedAt: p.updatedAt ?? t,
    ...p,
  } as SourceFileWithBatchSnapshots;
}

const FORBIDDEN_KEY_SUBSTRINGS = [
  'score_percent',
  'band',
  'impact_scorecard',
  'grade',
] as const;

function collectJsonKeys(v: unknown, out: Set<string>): void {
  if (v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) collectJsonKeys(x, out);
    return;
  }
  for (const k of Object.keys(v)) {
    out.add(k);
    collectJsonKeys((v as Record<string, unknown>)[k], out);
  }
}

function assertNoForbiddenDashboardKeys(data: object): void {
  const keys = new Set<string>();
  collectJsonKeys(data, keys);
  for (const k of keys) {
    const lower = k.toLowerCase();
    for (const f of FORBIDDEN_KEY_SUBSTRINGS) {
      expect(lower.includes(f)).toBe(false);
    }
  }
}

describe('fileTypeLabel', () => {
  it('uses extension when present', () => {
    expect(
      fileTypeLabel({
        fileName: 'path/to/foo.PDF',
        mimeType: 'application/pdf',
      }),
    ).toBe('PDF');
  });

  it('falls back to mime subtype', () => {
    expect(
      fileTypeLabel({ fileName: 'weird', mimeType: 'application/vnd.ms-powerpoint' }),
    ).toBe('VND.MS-POWERPOINT');
  });
});

describe('buildCourseDashboardPayload', () => {
  const course = { canvasCourseId: 'canvas-777' };

  it('returns zeros and empty arrays for an empty course', () => {
    const data = buildCourseDashboardPayload(course, []);
    expect(data).toMatchObject({
      canvas_course_id: 'canvas-777',
      issues: {
        total_reported: 0,
        resolved: 0,
        still_open: 0,
      },
      counts: {
        total_files: 0,
        files_scanned: 0,
        files_with_issues: 0,
        awaiting_review: 0,
        fixed_by_access_hub: 0,
        files_replaced_in_canvas: 0,
      },
      high_impact_files: [],
      issues_by_file_type: [],
      issue_categories: [],
    });
    assertNoForbiddenDashboardKeys(data);
  });

  it('rolls up issue_categories from latest batch file only (TASK-03 ordering)', () => {
    const older = batchFile({
      id: 'bf-old',
      sourceFileId: 'sf-1',
      createdAt: new Date('2026-01-01'),
      issueCategories: [cat({ category: 'a', found: 100, fixed: 0, remaining: 100 })],
    });
    const newer = batchFile({
      id: 'bf-new',
      sourceFileId: 'sf-1',
      createdAt: new Date('2026-02-01'),
      issueCategories: [
        cat({ category: 'a', found: 2, fixed: 1, remaining: 1 }),
        cat({ category: 'b', found: 3, fixed: 0, remaining: 3 }),
      ],
    });
    const sf = sourceFile({
      id: 'sf-1',
      courseId: 'c1',
      canvasFileId: 'cf1',
      displayName: 'Zebra',
      fileName: 'z.pdf',
      batchFiles: [older, newer],
    });
    const data = buildCourseDashboardPayload(course, [sf]);
    expect(data.issue_categories).toEqual([
      { category: 'a', found: 2, fixed: 1, remaining: 1 },
      { category: 'b', found: 3, fixed: 0, remaining: 3 },
    ]);
    expect(data.issues).toEqual({
      total_reported: 5,
      resolved: 1,
      still_open: 4,
    });
    expect(data.high_impact_files).toEqual([
      {
        source_file_id: 'sf-1',
        canvas_file_id: 'cf1',
        display_name: 'Zebra',
        open_issues: 4,
      },
    ]);
    assertNoForbiddenDashboardKeys(data);
  });

  it('counts pipeline and review fields', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    const scanned = sourceFile({
      id: 'sf-a',
      courseId: 'c1',
      canvasFileId: 'a',
      lastOutcome: 'completed',
      reviewAcknowledged: false,
      discoveredModifiedAt: t,
      s3SourceModifiedAt: t,
      batchedModifiedAt: t,
      batchFiles: [
        batchFile({
          id: 'bf1',
          sourceFileId: 'sf-a',
          createdAt: t,
          issueCategories: [
            cat({ category: 'x', found: 1, fixed: 0, remaining: 1 }),
          ],
        }),
      ],
    });
    const notScanned = sourceFile({
      id: 'sf-b',
      courseId: 'c1',
      canvasFileId: 'b',
      lastOutcome: null,
      s3SourceModifiedAt: null,
      batchedModifiedAt: null,
      discoveredModifiedAt: t,
      batchFiles: [],
    });
    const replaced = sourceFile({
      id: 'sf-c',
      courseId: 'c1',
      canvasFileId: 'c',
      lastOutcome: 'completed',
      reviewAcknowledged: true,
      writebackState: 'written',
      discoveredModifiedAt: t,
      s3SourceModifiedAt: t,
      batchedModifiedAt: t,
      batchFiles: [],
    });

    const data = buildCourseDashboardPayload(course, [scanned, notScanned, replaced]);
    expect(data.counts.total_files).toBe(3);
    expect(data.counts.files_scanned).toBe(2);
    expect(data.counts.files_with_issues).toBe(1);
    expect(data.counts.awaiting_review).toBe(1);
    expect(data.counts.fixed_by_access_hub).toBe(2);
    expect(data.counts.files_replaced_in_canvas).toBe(1);
  });

  it('groups issues_by_file_type for files with open issues', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    const pdf = sourceFile({
      id: 'sf-p',
      courseId: 'c1',
      canvasFileId: 'p',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      lastOutcome: 'completed',
      discoveredModifiedAt: t,
      s3SourceModifiedAt: t,
      batchedModifiedAt: t,
      batchFiles: [
        batchFile({
          id: 'bfp',
          sourceFileId: 'sf-p',
          createdAt: t,
          issueCategories: [cat({ category: 'c', found: 1, fixed: 0, remaining: 2 })],
        }),
      ],
    });
    const pptx = sourceFile({
      id: 'sf-q',
      courseId: 'c1',
      canvasFileId: 'q',
      fileName: 'b.pptx',
      mimeType: 'application/...',
      lastOutcome: 'completed',
      discoveredModifiedAt: t,
      s3SourceModifiedAt: t,
      batchedModifiedAt: t,
      batchFiles: [
        batchFile({
          id: 'bfq',
          sourceFileId: 'sf-q',
          createdAt: t,
          issueCategories: [cat({ category: 'c', found: 1, fixed: 0, remaining: 3 })],
        }),
      ],
    });
    const data = buildCourseDashboardPayload(course, [pdf, pptx]);
    expect(data.issues_by_file_type).toEqual([
      { file_type: 'PDF', files: 1, issues: 2 },
      { file_type: 'PPTX', files: 1, issues: 3 },
    ]);
  });
});
