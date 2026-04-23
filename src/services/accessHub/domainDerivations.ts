/**
 * Access Hub domain derivations (TASK-03 / VALIDATION-03).
 *
 * Sources: TECHNICAL_SPECIFICATION §2, §3, §0.3, §6.2–§6.4; docs/FILE_STATUSES.md
 *
 * ## Latest BatchFile for remediation snapshot (§0.3)
 *
 * When multiple `BatchFile` rows exist for one `SourceFile`, the “current remediation
 * snapshot” for dashboards and `FileIssueCategory` rollups is the row with the greatest
 * `createdAt`. Ties on `createdAt` break by lexicographically greater `id` (UUID), so the
 * choice is deterministic for a given DB state. Use this same rule everywhere (file list,
 * course dashboard, institution dashboard).
 */

import type {
  FileIssueCategory,
  LastOutcome,
  WritebackState,
} from '@prisma/client';

export { getCourseForInstitution as getCourse } from './tenantScope';

/** §6.3 — evaluation order matches TECHNICAL_SPECIFICATION pseudocode. */
export type PipelineLabel =
  | 'needs_upload'
  | 'needs_batching'
  | 'in_flight'
  | 'terminal'
  | 'deleted'
  | 'unknown';

export type CanvasReplacementState =
  | 'pending'
  | 'replaced'
  | 'failed'
  | 'not_applicable';

export type CanvasReplacementDerivation = {
  state: CanvasReplacementState;
  /** Nullable DB `SourceFile.writeback_state` for APIs that expose it alongside the enum. */
  writebackState: WritebackState | null;
};

export type SourceFilePipelineInput = {
  discoveredModifiedAt: Date;
  s3SourceModifiedAt: Date | null;
  batchedModifiedAt: Date | null;
  lastOutcome: LastOutcome | null;
};

export type IssueCategoryRollupRow = {
  category: string;
  found: number;
  fixed: number;
  remaining: number;
};

/** TECHNICAL_SPECIFICATION §2 / §6.2 — UI “opt out” (auto replace) ⇔ `true`. */
export function effectiveWritebackOptIn(params: {
  institutionWritebackOptIn: boolean;
  courseWritebackOptIn: boolean | null;
}): boolean {
  return params.courseWritebackOptIn ?? params.institutionWritebackOptIn;
}

export function needsUpload(sf: SourceFilePipelineInput): boolean {
  return (
    sf.s3SourceModifiedAt === null ||
    sf.s3SourceModifiedAt.getTime() < sf.discoveredModifiedAt.getTime()
  );
}

export function needsBatching(sf: SourceFilePipelineInput): boolean {
  if (sf.s3SourceModifiedAt === null) return false;
  return (
    sf.batchedModifiedAt === null ||
    sf.batchedModifiedAt.getTime() < sf.s3SourceModifiedAt.getTime()
  );
}

export function inFlightConnectivo(sf: SourceFilePipelineInput): boolean {
  if (
    sf.s3SourceModifiedAt === null ||
    sf.batchedModifiedAt === null ||
    sf.lastOutcome !== null
  ) {
    return false;
  }
  return sf.batchedModifiedAt.getTime() === sf.s3SourceModifiedAt.getTime();
}

export function terminalPipeline(sf: SourceFilePipelineInput): boolean {
  if (sf.lastOutcome === null || sf.lastOutcome === 'deleted') return false;
  if (sf.s3SourceModifiedAt === null || sf.batchedModifiedAt === null) return false;
  return sf.batchedModifiedAt.getTime() === sf.s3SourceModifiedAt.getTime();
}

export function pipelineLabel(sf: SourceFilePipelineInput): PipelineLabel {
  if (sf.lastOutcome === 'deleted') {
    return 'deleted';
  }
  if (needsUpload(sf)) {
    return 'needs_upload';
  }
  if (needsBatching(sf)) {
    return 'needs_batching';
  }
  if (inFlightConnectivo(sf)) {
    return 'in_flight';
  }
  if (terminalPipeline(sf)) {
    return 'terminal';
  }
  return 'unknown';
}

type LatestBatchSnapshotInput = {
  remediatedS3Key: string | null;
};

type SourceFileWritebackInput = {
  writebackState: WritebackState | null;
};

/**
 * §6.4 — stable API enum for Canvas replacement column.
 * When `effectiveWriteback` is false (UI “opt in” / no auto replace), replacement is
 * `not_applicable`. When true and a remediated artifact exists, map `writebackState`.
 */
export function deriveCanvasReplacementState(
  sourceFile: SourceFileWritebackInput,
  latestBatchFile: LatestBatchSnapshotInput | null,
  effectiveWriteback: boolean,
): CanvasReplacementDerivation {
  const writebackState = sourceFile.writebackState;

  if (!effectiveWriteback) {
    return { state: 'not_applicable', writebackState };
  }

  const hasRemediated =
    latestBatchFile?.remediatedS3Key !== null &&
    latestBatchFile?.remediatedS3Key !== undefined &&
    latestBatchFile.remediatedS3Key.length > 0;

  if (!hasRemediated) {
    return { state: 'not_applicable', writebackState };
  }

  if (writebackState === 'written') {
    return { state: 'replaced', writebackState };
  }
  if (writebackState === 'failed') {
    return { state: 'failed', writebackState };
  }
  // `null` or `skipped_stale` — replacement not completed successfully; still a live case.
  return { state: 'pending', writebackState };
}

/** True if `a` is a strictly newer snapshot than `b` (§0.3 ordering). */
export function batchFileIsNewerSnapshot(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): boolean {
  const dt = a.createdAt.getTime() - b.createdAt.getTime();
  if (dt !== 0) return dt > 0;
  return a.id > b.id;
}

/**
 * Pick the latest `BatchFile` for one source file from a list (e.g. all rows for that file).
 */
export function selectLatestBatchFileForSnapshot<
  T extends { createdAt: Date; id: string },
>(batchFiles: T[]): T | null {
  if (batchFiles.length === 0) return null;
  let best = batchFiles[0]!;
  for (let i = 1; i < batchFiles.length; i++) {
    const cur = batchFiles[i]!;
    if (batchFileIsNewerSnapshot(cur, best)) {
      best = cur;
    }
  }
  return best;
}

/**
 * From a flat list of batch files (multiple courses / source files), keep one row per
 * `sourceFileId` using the same latest rule — for institution- or course-scoped rollups.
 */
export function pickLatestBatchFilePerSourceFile<
  T extends { sourceFileId: string; createdAt: Date; id: string },
>(batchFiles: T[]): T[] {
  const map = new Map<string, T>();
  for (const bf of batchFiles) {
    const cur = map.get(bf.sourceFileId);
    if (!cur || batchFileIsNewerSnapshot(bf, cur)) {
      map.set(bf.sourceFileId, bf);
    }
  }
  return [...map.values()];
}

type CategoryRow = Pick<
  FileIssueCategory,
  'category' | 'found' | 'fixed' | 'remaining'
>;

/**
 * §0.3 — sum counts per `category` across the provided batch files’ category rows.
 * Caller passes only “latest snapshot” batch files (see `pickLatestBatchFilePerSourceFile`).
 * Sort: category name ascending (stable, deterministic).
 */
export function rollupIssueCategories(
  batchFiles: Array<{ issueCategories: CategoryRow[] }>,
): IssueCategoryRollupRow[] {
  const acc = new Map<
    string,
    { found: number; fixed: number; remaining: number }
  >();

  for (const bf of batchFiles) {
    for (const row of bf.issueCategories) {
      const cur = acc.get(row.category) ?? { found: 0, fixed: 0, remaining: 0 };
      cur.found += row.found;
      cur.fixed += row.fixed;
      cur.remaining += row.remaining;
      acc.set(row.category, cur);
    }
  }

  const out: IssueCategoryRollupRow[] = [...acc.entries()].map(([category, v]) => ({
    category,
    found: clampNonNegative(v.found),
    fixed: clampNonNegative(v.fixed),
    remaining: clampNonNegative(v.remaining),
  }));

  out.sort((a, b) => a.category.localeCompare(b.category));
  return out;
}

/** Convenience: total “open” issues from a rollup = sum of `remaining` (VALIDATION-03). */
export function totalOpenIssuesFromRollup(rows: IssueCategoryRollupRow[]): number {
  return rows.reduce((s, r) => s + r.remaining, 0);
}

/**
 * Sum `remaining` on one batch file’s categories (same as single-file rollup open issues).
 */
export function openIssuesFromBatchCategories(categories: CategoryRow[]): number {
  return clampNonNegative(
    categories.reduce((s, r) => s + r.remaining, 0),
  );
}

function clampNonNegative(n: number): number {
  return n < 0 ? 0 : n;
}
