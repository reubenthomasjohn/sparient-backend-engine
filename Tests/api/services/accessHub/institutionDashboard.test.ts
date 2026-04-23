import { describe, it, expect } from 'vitest';
import type { BatchFile, FileIssueCategory, SourceFile } from '@prisma/client';
import { buildInstitutionDashboardPayload } from '@/services/accessHub/institutionDashboard';

const T = new Date('2026-01-01T00:00:00Z');
const INST_ID = '11111111-1111-1111-1111-111111111111';

function cat(
  p: Pick<FileIssueCategory, 'category' | 'found' | 'fixed' | 'remaining'>,
): FileIssueCategory {
  return { id: 'c', batchFileId: 'bf', ...p };
}

function bf(
  p: { id: string; sourceFileId: string; createdAt?: Date } & Partial<BatchFile> & {
    issueCategories: FileIssueCategory[];
  },
): BatchFile & { issueCategories: FileIssueCategory[] } {
  return {
    batchId: 'b', canvasFileId: 'cf', s3SourceKey: 'k',
    sourceModifiedAt: T, connectivoState: null, qualityLabel: null,
    remediatedS3Key: null, remediatedS3Bucket: null, totalPages: null,
    processingTimeSecs: null, verapdfErrors: null, verapdfWarnings: null,
    errorMessage: null, updatedAt: T, createdAt: T,
    ...p,
  } as BatchFile & { issueCategories: FileIssueCategory[] };
}

function sf(
  id: string,
  courseId: string,
  overrides: Partial<SourceFile> = {},
  batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }> = [],
): SourceFile & { batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }> } {
  return {
    id, courseId,
    canvasFileId: `cf-${id}`,
    displayName: `Doc ${id}`,
    fileName: `doc-${id}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: null,
    discoveredModifiedAt: T,
    s3SourceKey: 'k', s3SourceBucket: 'b',
    s3SourceModifiedAt: T, batchedModifiedAt: T,
    lastOutcome: 'completed',
    lastFailureReason: null, retryCount: 0, maxRetries: 3,
    nextRetryAt: null, writebackState: null, lastWritebackModifiedAt: null,
    reviewAcknowledged: false, createdAt: T, updatedAt: T,
    ...overrides,
    batchFiles,
  } as SourceFile & { batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }> };
}

const FORBIDDEN_KEYS = ['score_percent', 'band', 'impact_scorecard', 'account_accessibility'];

function assertNoForbiddenKeys(data: object): void {
  const json = JSON.stringify(data);
  for (const k of FORBIDDEN_KEYS) {
    expect(json.toLowerCase()).not.toContain(k);
  }
}

describe('buildInstitutionDashboardPayload', () => {
  it('returns zeros and empty arrays for empty institution', () => {
    const data = buildInstitutionDashboardPayload(INST_ID, [], []);
    expect(data).toMatchObject({
      institution_id: INST_ID,
      scanned_courses: 0,
      issues: { total_reported: 0, resolved: 0, still_open: 0 },
      content_summary: { errors: 0, suggestions: 0, issues_fixed: 0, marked_resolved: 0 },
      file_pipeline: {
        total_files: 0, files_scanned: 0, files_with_issues: 0,
        awaiting_review: 0, fixed_by_access_hub: 0, files_replaced_in_canvas: 0,
      },
      issue_categories: [],
    });
    assertNoForbiddenKeys(data);
  });

  it('uses latest BatchFile per SourceFile for rollup (§0.3)', () => {
    const older = bf({ id: 'bf-old', sourceFileId: 'sf1', createdAt: new Date('2026-01-01'),
      issueCategories: [cat({ category: 'a', found: 99, fixed: 0, remaining: 99 })] });
    const newer = bf({ id: 'bf-new', sourceFileId: 'sf1', createdAt: new Date('2026-02-01'),
      issueCategories: [cat({ category: 'a', found: 4, fixed: 1, remaining: 3 })] });

    const data = buildInstitutionDashboardPayload(INST_ID,
      [sf('sf1', 'c1', {}, [older, newer])], ['c1']);

    expect(data.issue_categories).toEqual([
      { category: 'a', found: 4, fixed: 1, remaining: 3 },
    ]);
    expect(data.issues).toEqual({ total_reported: 4, resolved: 1, still_open: 3 });
  });

  it('aggregates issue_categories across multiple courses', () => {
    const fileA = sf('sf-a', 'c1', {}, [
      bf({ id: 'bf-a', sourceFileId: 'sf-a', createdAt: T,
        issueCategories: [cat({ category: 'x', found: 2, fixed: 1, remaining: 1 })] }),
    ]);
    const fileB = sf('sf-b', 'c2', {}, [
      bf({ id: 'bf-b', sourceFileId: 'sf-b', createdAt: T,
        issueCategories: [cat({ category: 'x', found: 3, fixed: 0, remaining: 3 })] }),
    ]);

    const data = buildInstitutionDashboardPayload(INST_ID, [fileA, fileB], ['c1', 'c2']);
    expect(data.issue_categories).toEqual([
      { category: 'x', found: 5, fixed: 1, remaining: 4 },
    ]);
    expect(data.issues).toEqual({ total_reported: 5, resolved: 1, still_open: 4 });
  });

  it('counts scanned_courses from unique courseIds with at least one terminal file', () => {
    const scannedFile = sf('sf1', 'c1', { lastOutcome: 'completed' });
    const unscannedFile = sf('sf2', 'c2', { lastOutcome: null, s3SourceModifiedAt: null, batchedModifiedAt: null });

    const data = buildInstitutionDashboardPayload(INST_ID, [scannedFile, unscannedFile], ['c1', 'c2']);
    expect(data.scanned_courses).toBe(1);
  });

  it('counts both courses as scanned when both have terminal files', () => {
    const f1 = sf('sf1', 'c1', { lastOutcome: 'completed' });
    const f2 = sf('sf2', 'c2', { lastOutcome: 'completed_with_warnings' });

    const data = buildInstitutionDashboardPayload(INST_ID, [f1, f2], ['c1', 'c2']);
    expect(data.scanned_courses).toBe(2);
  });

  it('file_pipeline counts are consistent', () => {
    const fixed = sf('sf-fix', 'c1', {
      lastOutcome: 'completed',
      writebackState: 'written',
      reviewAcknowledged: true,
    });
    const pending = sf('sf-pend', 'c1', {
      lastOutcome: null,
      s3SourceModifiedAt: null,
      batchedModifiedAt: null,
    });
    const withIssues = sf('sf-iss', 'c1', { lastOutcome: 'completed' }, [
      bf({ id: 'bf1', sourceFileId: 'sf-iss', createdAt: T,
        issueCategories: [cat({ category: 'a', found: 1, fixed: 0, remaining: 2 })] }),
    ]);

    const data = buildInstitutionDashboardPayload(INST_ID, [fixed, pending, withIssues], ['c1']);
    expect(data.file_pipeline.total_files).toBe(3);
    expect(data.file_pipeline.files_scanned).toBe(2);  // fixed + withIssues
    expect(data.file_pipeline.files_with_issues).toBe(1);  // withIssues has remaining > 0
    expect(data.file_pipeline.fixed_by_access_hub).toBe(2); // fixed + withIssues (completed)
    expect(data.file_pipeline.files_replaced_in_canvas).toBe(1); // fixed writebackState=written
  });

  it('content_summary.suggestions is 0 (no schema support §0.4)', () => {
    const data = buildInstitutionDashboardPayload(INST_ID, [], []);
    expect(data.content_summary.suggestions).toBe(0);
  });

  it('content_summary.marked_resolved counts reviewAcknowledged files', () => {
    const acked = sf('sf-a', 'c1', { reviewAcknowledged: true });
    const notAcked = sf('sf-b', 'c1', { reviewAcknowledged: false });
    const data = buildInstitutionDashboardPayload(INST_ID, [acked, notAcked], ['c1']);
    expect(data.content_summary.marked_resolved).toBe(1);
  });

  it('no forbidden keys anywhere in response', () => {
    const data = buildInstitutionDashboardPayload(INST_ID,
      [sf('sf1', 'c1', {}, [bf({ id: 'bf1', sourceFileId: 'sf1', createdAt: T,
        issueCategories: [cat({ category: 'a', found: 1, fixed: 0, remaining: 1 })] })])],
      ['c1']);
    assertNoForbiddenKeys(data);
  });
});
