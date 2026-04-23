import { describe, it, expect } from 'vitest';
import {
  batchFileIsNewerSnapshot,
  deriveCanvasReplacementState,
  effectiveWritebackOptIn,
  inFlightConnectivo,
  openIssuesFromBatchCategories,
  pickLatestBatchFilePerSourceFile,
  pipelineLabel,
  rollupIssueCategories,
  selectLatestBatchFileForSnapshot,
  terminalPipeline,
  totalOpenIssuesFromRollup,
  type SourceFilePipelineInput,
} from '@/services/accessHub/domainDerivations';

const d = (s: string) => new Date(s);

function sf(partial: Partial<SourceFilePipelineInput> & Pick<SourceFilePipelineInput, 'discoveredModifiedAt'>): SourceFilePipelineInput {
  return {
    s3SourceModifiedAt: null,
    batchedModifiedAt: null,
    lastOutcome: null,
    ...partial,
  };
}

describe('effectiveWritebackOptIn', () => {
  it('uses course override when set', () => {
    expect(
      effectiveWritebackOptIn({
        institutionWritebackOptIn: false,
        courseWritebackOptIn: true,
      }),
    ).toBe(true);
    expect(
      effectiveWritebackOptIn({
        institutionWritebackOptIn: true,
        courseWritebackOptIn: false,
      }),
    ).toBe(false);
  });

  it('falls back to institution when course override is null', () => {
    expect(
      effectiveWritebackOptIn({
        institutionWritebackOptIn: true,
        courseWritebackOptIn: null,
      }),
    ).toBe(true);
    expect(
      effectiveWritebackOptIn({
        institutionWritebackOptIn: false,
        courseWritebackOptIn: null,
      }),
    ).toBe(false);
  });
});

describe('pipelineLabel (FILE_STATUSES + §6.3)', () => {
  it('returns deleted when lastOutcome is deleted', () => {
    expect(
      pipelineLabel(
        sf({
          discoveredModifiedAt: d('2026-01-01'),
          s3SourceModifiedAt: d('2026-01-01'),
          batchedModifiedAt: d('2026-01-01'),
          lastOutcome: 'deleted',
        }),
      ),
    ).toBe('deleted');
  });

  it('returns needs_upload when S3 lags discovery', () => {
    expect(
      pipelineLabel(
        sf({
          discoveredModifiedAt: d('2026-01-02'),
          s3SourceModifiedAt: d('2026-01-01'),
          batchedModifiedAt: null,
          lastOutcome: null,
        }),
      ),
    ).toBe('needs_upload');
  });

  it('returns needs_upload when S3 is missing', () => {
    expect(
      pipelineLabel(
        sf({
          discoveredModifiedAt: d('2026-01-01'),
          s3SourceModifiedAt: null,
          lastOutcome: null,
        }),
      ),
    ).toBe('needs_upload');
  });

  it('returns needs_batching when S3 fresh but not batched to same version', () => {
    expect(
      pipelineLabel(
        sf({
          discoveredModifiedAt: d('2026-01-01'),
          s3SourceModifiedAt: d('2026-01-01'),
          batchedModifiedAt: null,
          lastOutcome: null,
        }),
      ),
    ).toBe('needs_batching');
  });

  it('returns in_flight when batched equals S3 and no outcome yet', () => {
    const t = d('2026-01-01');
    expect(
      pipelineLabel(
        sf({
          discoveredModifiedAt: t,
          s3SourceModifiedAt: t,
          batchedModifiedAt: t,
          lastOutcome: null,
        }),
      ),
    ).toBe('in_flight');
  });

  it('returns terminal when outcome set and batched equals S3', () => {
    const t = d('2026-01-01');
    expect(
      pipelineLabel(
        sf({
          discoveredModifiedAt: t,
          s3SourceModifiedAt: t,
          batchedModifiedAt: t,
          lastOutcome: 'completed',
        }),
      ),
    ).toBe('terminal');
  });

  it('is deterministic for identical inputs', () => {
    const row = sf({
      discoveredModifiedAt: d('2026-01-01'),
      s3SourceModifiedAt: d('2026-01-01'),
      batchedModifiedAt: d('2026-01-01'),
      lastOutcome: 'completed',
    });
    expect(pipelineLabel(row)).toBe(pipelineLabel(row));
  });
});

describe('predicate helpers', () => {
  it('terminalPipeline is false for deleted outcome', () => {
    const t = d('2026-01-01');
    expect(
      terminalPipeline(
        sf({
          discoveredModifiedAt: t,
          s3SourceModifiedAt: t,
          batchedModifiedAt: t,
          lastOutcome: 'deleted',
        }),
      ),
    ).toBe(false);
  });

  it('inFlightConnectivo is false when outcomes exist', () => {
    const t = d('2026-01-01');
    expect(inFlightConnectivo(sf({ discoveredModifiedAt: t, s3SourceModifiedAt: t, batchedModifiedAt: t, lastOutcome: 'failed' }))).toBe(
      false,
    );
  });
});

describe('latest BatchFile selection (§0.3)', () => {
  it('picks greater createdAt', () => {
    const a = { id: 'a', createdAt: d('2026-01-01'), sourceFileId: 'sf1' };
    const b = { id: 'b', createdAt: d('2026-01-02'), sourceFileId: 'sf1' };
    expect(selectLatestBatchFileForSnapshot([a, b])).toEqual(b);
  });

  it('breaks ties by greater id', () => {
    const t = d('2026-01-01');
    const x = { id: 'aaa', createdAt: t, sourceFileId: 'sf1' };
    const y = { id: 'bbb', createdAt: t, sourceFileId: 'sf1' };
    expect(selectLatestBatchFileForSnapshot([x, y])).toEqual(y);
    expect(batchFileIsNewerSnapshot(y, x)).toBe(true);
    expect(batchFileIsNewerSnapshot(x, y)).toBe(false);
  });

  it('pickLatestBatchFilePerSourceFile keeps one row per source file', () => {
    const rows = [
      { id: '1', sourceFileId: 'sf-a', createdAt: d('2026-01-01'), issueCategories: [] as { category: string; found: number; fixed: number; remaining: number }[] },
      { id: '2', sourceFileId: 'sf-a', createdAt: d('2026-01-03'), issueCategories: [] },
      { id: '3', sourceFileId: 'sf-b', createdAt: d('2026-01-02'), issueCategories: [] },
    ];
    const latest = pickLatestBatchFilePerSourceFile(rows);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.sourceFileId === 'sf-a')?.id).toBe('2');
    expect(latest.find((r) => r.sourceFileId === 'sf-b')?.id).toBe('3');
  });
});

describe('rollupIssueCategories (§0.3)', () => {
  it('returns empty for empty input', () => {
    expect(rollupIssueCategories([])).toEqual([]);
  });

  it('returns empty when batch files have no categories', () => {
    expect(rollupIssueCategories([{ issueCategories: [] }])).toEqual([]);
  });

  it('sums by category and sorts by name', () => {
    const rows = rollupIssueCategories([
      {
        issueCategories: [
          { category: 'z', found: 1, fixed: 0, remaining: 2 },
          { category: 'a', found: 3, fixed: 1, remaining: 1 },
        ],
      },
      {
        issueCategories: [
          { category: 'a', found: 2, fixed: 0, remaining: 3 },
        ],
      },
    ]);
    expect(rows).toEqual([
      { category: 'a', found: 5, fixed: 1, remaining: 4 },
      { category: 'z', found: 1, fixed: 0, remaining: 2 },
    ]);
    expect(totalOpenIssuesFromRollup(rows)).toBe(6);
  });

  it('clamps negative sums to zero', () => {
    const rows = rollupIssueCategories([
      {
        issueCategories: [{ category: 'x', found: -5, fixed: 0, remaining: -1 }],
      },
    ]);
    expect(rows[0]).toEqual({ category: 'x', found: 0, fixed: 0, remaining: 0 });
  });
});

describe('open issues helpers', () => {
  it('openIssuesFromBatchCategories sums remaining', () => {
    expect(
      openIssuesFromBatchCategories([
        { category: 'a', found: 1, fixed: 0, remaining: 2 },
        { category: 'b', found: 0, fixed: 0, remaining: 3 },
      ]),
    ).toBe(5);
  });
});

describe('deriveCanvasReplacementState (§6.4)', () => {
  it('not_applicable when effective writeback is false', () => {
    expect(
      deriveCanvasReplacementState(
        { writebackState: null },
        { remediatedS3Key: 'key' },
        false,
      ),
    ).toEqual({ state: 'not_applicable', writebackState: null });
  });

  it('not_applicable when writeback on but no remediated key', () => {
    expect(
      deriveCanvasReplacementState(
        { writebackState: null },
        { remediatedS3Key: null },
        true,
      ),
    ).toEqual({ state: 'not_applicable', writebackState: null });
  });

  it('pending when remediated exists and writeback not finished', () => {
    expect(
      deriveCanvasReplacementState(
        { writebackState: null },
        { remediatedS3Key: 'k' },
        true,
      ),
    ).toEqual({ state: 'pending', writebackState: null });
  });

  it('pending for skipped_stale with remediated artifact', () => {
    expect(
      deriveCanvasReplacementState(
        { writebackState: 'skipped_stale' },
        { remediatedS3Key: 'k' },
        true,
      ),
    ).toEqual({ state: 'pending', writebackState: 'skipped_stale' });
  });

  it('replaced and failed map writeback state', () => {
    expect(
      deriveCanvasReplacementState(
        { writebackState: 'written' },
        { remediatedS3Key: 'k' },
        true,
      ),
    ).toEqual({ state: 'replaced', writebackState: 'written' });
    expect(
      deriveCanvasReplacementState(
        { writebackState: 'failed' },
        { remediatedS3Key: 'k' },
        true,
      ),
    ).toEqual({ state: 'failed', writebackState: 'failed' });
  });
});
