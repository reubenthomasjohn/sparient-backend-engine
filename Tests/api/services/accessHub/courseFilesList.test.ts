import { describe, it, expect } from 'vitest';
import type { BatchFile, FileIssueCategory, SourceFile } from '@prisma/client';
import {
  buildFileListItem,
  buildStatusSummary,
  matchesStatusFilter,
  normalisedFileType,
  parseFileListQuery,
  type SourceFileForList,
} from '@/services/accessHub/courseFilesList';

// ─── helpers ──────────────────────────────────────────────────────────────────

function cat(
  p: Pick<FileIssueCategory, 'category' | 'found' | 'fixed' | 'remaining'>,
): FileIssueCategory {
  return { id: 'c', batchFileId: 'bf', ...p };
}

function bf(
  p: Partial<BatchFile> & {
    id: string;
    sourceFileId: string;
    createdAt: Date;
    issueCategories: FileIssueCategory[];
  },
): BatchFile & { issueCategories: FileIssueCategory[] } {
  const now = new Date();
  return {
    batchId: 'b',
    canvasFileId: 'cf',
    s3SourceKey: 'k',
    sourceModifiedAt: now,
    connectivoState: null,
    qualityLabel: null,
    remediatedS3Key: null,
    remediatedS3Bucket: null,
    totalPages: null,
    processingTimeSecs: null,
    verapdfErrors: null,
    verapdfWarnings: null,
    errorMessage: null,
    updatedAt: now,
    ...p,
  } as BatchFile & { issueCategories: FileIssueCategory[] };
}

const T = new Date('2026-01-01T00:00:00Z');

function sf(
  p: Partial<SourceFile> & {
    id: string;
    courseId: string;
    canvasFileId: string;
    batchFiles: Array<BatchFile & { issueCategories: FileIssueCategory[] }>;
  },
): SourceFileForList {
  return {
    displayName: 'Doc.pdf',
    fileName: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: null,
    discoveredModifiedAt: T,
    s3SourceKey: 'k',
    s3SourceBucket: 'b',
    s3SourceModifiedAt: T,
    batchedModifiedAt: T,
    lastOutcome: 'completed',
    lastFailureReason: null,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    writebackState: null,
    lastWritebackModifiedAt: null,
    reviewAcknowledged: false,
    createdAt: T,
    updatedAt: T,
    ...p,
  } as SourceFileForList;
}

// ─── normalisedFileType ───────────────────────────────────────────────────────

describe('normalisedFileType', () => {
  it.each([
    ['report.pdf', 'application/pdf', 'pdf'],
    ['slide.pptx', 'application/vnd.ms-powerpoint', 'powerpoint'],
    ['data.xlsx', 'application/vnd.ms-excel', 'excel'],
    ['note.docx', 'application/msword', 'word'],
    ['photo.PNG', 'image/png', 'image'],
    ['clip.mp4', 'video/mp4', 'video'],
    ['archive.zip', 'application/zip', 'other'],
    ['nodot', 'application/octet-stream', 'other'],
  ])('%s → %s', (fileName, mimeType, expected) => {
    expect(normalisedFileType(fileName, mimeType)).toBe(expected);
  });
});

// ─── buildStatusSummary ───────────────────────────────────────────────────────

describe('buildStatusSummary', () => {
  it.each([
    ['deleted', 0, 0, 'File deleted from Canvas'],
    ['needs_upload', 0, 0, 'Pending upload'],
    ['needs_batching', 0, 0, 'Pending scan'],
    ['in_flight', 0, 0, 'Scan in progress'],
    ['terminal', 3, 5, '3 issues remaining'],
    ['terminal', 1, 1, '1 issue remaining'],
    ['terminal', 0, 5, 'All issues resolved'],
    ['terminal', 0, 0, 'No accessibility issues detected'],
    ['unknown', 0, 0, 'Status unknown'],
  ] as const)('pipeline=%s open=%d found=%d → %s', (p, o, f, expected) => {
    expect(buildStatusSummary(p, o, f)).toBe(expected);
  });
});

// ─── matchesStatusFilter ──────────────────────────────────────────────────────

describe('matchesStatusFilter', () => {
  it('all matches any pipeline', () => {
    for (const p of ['needs_upload', 'terminal', 'in_flight', 'deleted', 'unknown'] as const) {
      expect(matchesStatusFilter(p, 'all')).toBe(true);
    }
  });

  it('in_progress matches upload/batching/in_flight only', () => {
    expect(matchesStatusFilter('needs_upload', 'in_progress')).toBe(true);
    expect(matchesStatusFilter('needs_batching', 'in_progress')).toBe(true);
    expect(matchesStatusFilter('in_flight', 'in_progress')).toBe(true);
    expect(matchesStatusFilter('terminal', 'in_progress')).toBe(false);
    expect(matchesStatusFilter('deleted', 'in_progress')).toBe(false);
  });

  it('complete matches terminal only', () => {
    expect(matchesStatusFilter('terminal', 'complete')).toBe(true);
    expect(matchesStatusFilter('needs_upload', 'complete')).toBe(false);
  });

  it('failed maps to unknown pipeline (permanently_failed / stuck)', () => {
    expect(matchesStatusFilter('unknown', 'failed')).toBe(true);
    expect(matchesStatusFilter('terminal', 'failed')).toBe(false);
  });
});

// ─── parseFileListQuery ───────────────────────────────────────────────────────

describe('parseFileListQuery', () => {
  it('applies defaults', () => {
    const q = parseFileListQuery({});
    expect(q.status).toBe('all');
    expect(q.sort).toBe('open_issues_desc');
    expect(q.page).toBe(1);
    expect(q.page_size).toBe(20);
    expect(q.hide_replaced_in_canvas).toBe(false);
  });

  it('accepts valid values', () => {
    const q = parseFileListQuery({
      status: 'complete',
      sort: 'display_name_asc',
      page: '2',
      page_size: '50',
      hide_replaced_in_canvas: 'true',
      q: 'hello',
    });
    expect(q.status).toBe('complete');
    expect(q.sort).toBe('display_name_asc');
    expect(q.page).toBe(2);
    expect(q.page_size).toBe(50);
    expect(q.hide_replaced_in_canvas).toBe(true);
    expect(q.q).toBe('hello');
  });

  it('throws 400 for invalid status', () => {
    expect(() => parseFileListQuery({ status: 'nope' })).toThrow();
  });

  it('throws 400 for page_size > 100', () => {
    expect(() => parseFileListQuery({ page_size: '101' })).toThrow();
  });

  it('throws 400 for page < 1', () => {
    expect(() => parseFileListQuery({ page: '0' })).toThrow();
  });
});

// ─── buildFileListItem ────────────────────────────────────────────────────────

describe('buildFileListItem', () => {
  it('builds a full item with correct shape and no forbidden keys', () => {
    const item = buildFileListItem(
      sf({
        id: 'sf1',
        courseId: 'c1',
        canvasFileId: 'cf1',
        displayName: 'Report.pdf',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        lastOutcome: 'completed',
        reviewAcknowledged: true,
        batchFiles: [
          bf({
            id: 'bf1',
            sourceFileId: 'sf1',
            createdAt: new Date('2026-02-01'),
            issueCategories: [cat({ category: 'x', found: 2, fixed: 1, remaining: 1 })],
          }),
        ],
      }),
      false,
    );

    expect(item.source_file_id).toBe('sf1');
    expect(item.canvas_file_id).toBe('cf1');
    expect(item.display_name).toBe('Report.pdf');
    expect(item.file_type).toBe('pdf');
    expect(item.open_issues).toBe(1);
    expect(item.review_acknowledged).toBe(true);
    expect(item.status.pipeline).toBe('terminal');
    expect(item.status.last_outcome).toBe('completed');
    expect(item.status.summary).toBe('1 issue remaining');
    expect(item.canvas_replacement.state).toBe('not_applicable');
    // No forbidden keys
    expect(item).not.toHaveProperty('comment');
    // Internal fields present (stripped by getCourseFileList)
    expect(item._pipeline).toBe('terminal');
    expect(item._openIssues).toBe(1);
  });

  it('uses latest batch file only for open_issues (TASK-03 rule)', () => {
    const older = bf({
      id: 'bf-old',
      sourceFileId: 'sf1',
      createdAt: new Date('2026-01-01'),
      issueCategories: [cat({ category: 'a', found: 99, fixed: 0, remaining: 99 })],
    });
    const newer = bf({
      id: 'bf-new',
      sourceFileId: 'sf1',
      createdAt: new Date('2026-03-01'),
      issueCategories: [cat({ category: 'a', found: 2, fixed: 1, remaining: 1 })],
    });
    const item = buildFileListItem(
      sf({ id: 'sf1', courseId: 'c1', canvasFileId: 'cf1', batchFiles: [older, newer] }),
      false,
    );
    expect(item.open_issues).toBe(1);
  });

  it('sets canvas_replacement.state=replaced when writeback=written and effectiveWriteback=true', () => {
    const item = buildFileListItem(
      sf({
        id: 'sf1',
        courseId: 'c1',
        canvasFileId: 'cf1',
        writebackState: 'written',
        batchFiles: [
          bf({
            id: 'bf1',
            sourceFileId: 'sf1',
            createdAt: T,
            remediatedS3Key: 'key/remediated.pdf',
            issueCategories: [],
          }),
        ],
      }),
      true,
    );
    expect(item.canvas_replacement.state).toBe('replaced');
    expect(item.canvas_replacement.writeback_state).toBe('written');
  });

  it('last_updated is the later of sf.updatedAt and latest bf.createdAt', () => {
    const sfUpdated = new Date('2026-01-15T00:00:00Z');
    const bfCreated = new Date('2026-02-20T00:00:00Z');
    const item = buildFileListItem(
      sf({
        id: 'sf1',
        courseId: 'c1',
        canvasFileId: 'cf1',
        updatedAt: sfUpdated,
        batchFiles: [
          bf({ id: 'bf1', sourceFileId: 'sf1', createdAt: bfCreated, issueCategories: [] }),
        ],
      }),
      false,
    );
    expect(item.last_updated).toBe(bfCreated.toISOString());
  });
});
