import { describe, it, expect } from 'vitest';
import prisma from '../../../src/db/client';
import { RemediationService } from '../../../src/services/remediation/RemediationService';
import { createBatchFixture, buildPayload } from '../../fixtures';

const service = new RemediationService();

describe('RemediationService.handleResults', () => {
  describe('first response', () => {
    it('promotes batch to completed and writes per-file outcomes', async () => {
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      const payload = buildPayload({
        externalBatchId: fx.batchId,
        files: [
          { file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' },
          { file_id: fx.sourceFiles[1].id, state: 'Completed', quality_label: 'Good' },
        ],
      });

      await service.handleResults(fx.batchId, payload, 'responses/first.json');

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.status).toBe('completed');
      expect(batch.succeeded).toBe(2);
      expect(batch.failed).toBe(0);
      expect(batch.requiresReview).toBe(0);
      expect(batch.numRetries).toBe(0);

      const batchFiles = await prisma.batchFile.findMany({ where: { batchId: fx.batchId } });
      expect(batchFiles.every((bf) => bf.connectivoState === 'completed')).toBe(true);

      const responses = await prisma.batchResponse.findMany({ where: { batchId: fx.batchId } });
      expect(responses).toHaveLength(1);
      expect(responses[0].s3Key).toBe('responses/first.json');
    });

    it('marks files missing from the payload as failed', async () => {
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      const payload = buildPayload({
        externalBatchId: fx.batchId,
        files: [
          { file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' },
          // file_id[1] omitted — should be marked failed
        ],
      });

      await service.handleResults(fx.batchId, payload, 'responses/first.json');

      const missingBatchFile = await prisma.batchFile.findFirstOrThrow({
        where: { batchId: fx.batchId, sourceFileId: fx.sourceFiles[1].id },
      });
      expect(missingBatchFile.connectivoState).toBe('failed');
      expect(missingBatchFile.errorMessage).toMatch(/missing/i);

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.status).toBe('completed_with_warnings');
      expect(batch.succeeded).toBe(1);
      expect(batch.failed).toBe(1);
    });

    it('classifies Cancelled state as failed via STATE_MAP', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      const payload = buildPayload({
        externalBatchId: fx.batchId,
        files: [
          {
            file_id: fx.sourceFiles[0].id,
            state: 'Cancelled',
            quality_label: 'Failed',
            error: 'cancelled by user',
          },
        ],
      });

      await service.handleResults(fx.batchId, payload, 'responses/first.json');

      const bf = await prisma.batchFile.findFirstOrThrow({ where: { batchId: fx.batchId } });
      expect(bf.connectivoState).toBe('failed');

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.status).toBe('failed');
      expect(batch.failed).toBe(1);
    });
  });

  describe('Processing files', () => {
    it('keeps batch pending when any file is still Processing', async () => {
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      const payload = buildPayload({
        externalBatchId: fx.batchId,
        files: [
          { file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' },
          { file_id: fx.sourceFiles[1].id, state: 'Processing', quality_label: null },
        ],
      });

      await service.handleResults(fx.batchId, payload, 'responses/first.json');

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.status).toBe('pending');

      const processingFile = await prisma.batchFile.findFirstOrThrow({
        where: { batchId: fx.batchId, sourceFileId: fx.sourceFiles[1].id },
      });
      expect(processingFile.connectivoState).toBeNull();
    });

    it('handles lowercase processing state too (defensive against casing change)', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      const payload = buildPayload({
        externalBatchId: fx.batchId,
        files: [{ file_id: fx.sourceFiles[0].id, state: 'processing' }],
      });

      await service.handleResults(fx.batchId, payload, 'responses/first.json');

      const bf = await prisma.batchFile.findFirstOrThrow({ where: { batchId: fx.batchId } });
      expect(bf.connectivoState).toBeNull();
    });

    it('promotes batch when a follow-up response carries the terminal state', async () => {
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      // First response: file 2 is still processing.
      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            { file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' },
            { file_id: fx.sourceFiles[1].id, state: 'Processing', quality_label: null },
          ],
        }),
        'responses/first.json',
      );

      let batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.status).toBe('pending');

      // Follow-up response: file 2 has settled.
      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [{ file_id: fx.sourceFiles[1].id, state: 'Completed', quality_label: 'Good' }],
        }),
        'responses/followup.json',
      );

      batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.status).toBe('completed');
      expect(batch.succeeded).toBe(2);
      expect(batch.numRetries).toBe(1);
    });
  });

  describe('retries', () => {
    it('flips a failed file to succeeded without touching other files', async () => {
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            { file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' },
            { file_id: fx.sourceFiles[1].id, state: 'Failed', quality_label: 'Failed' },
          ],
        }),
        'responses/first.json',
      );

      let batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.succeeded).toBe(1);
      expect(batch.failed).toBe(1);

      // Retry only for the failed file, now Connectivo got it right.
      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [{ file_id: fx.sourceFiles[1].id, state: 'Completed', quality_label: 'Excellent' }],
        }),
        'responses/retry.json',
      );

      batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.succeeded).toBe(2);
      expect(batch.failed).toBe(0);
      expect(batch.status).toBe('completed');
      expect(batch.numRetries).toBe(1);

      // File 1 should NOT have been re-marked failed by the retry's "missing"
      // logic — that branch is gated on isFirstResponse.
      const bf1 = await prisma.batchFile.findFirstOrThrow({
        where: { batchId: fx.batchId, sourceFileId: fx.sourceFiles[0].id },
      });
      expect(bf1.connectivoState).toBe('completed');
    });

    it('does not pull completedAt backward when retry has an earlier timestamp', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          completedAt: '2026-05-10T12:00:00Z',
          files: [{ file_id: fx.sourceFiles[0].id, state: 'Failed', quality_label: 'Failed' }],
        }),
        'responses/first.json',
      );

      const firstBatch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      const firstCompletedAt = firstBatch.completedAt!.getTime();

      // Retry payload claims a completed_at *earlier* than the first response —
      // we should keep the later value as "last activity".
      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          completedAt: '2026-05-09T12:00:00Z',
          files: [{ file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' }],
        }),
        'responses/retry.json',
      );

      const afterRetry = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(afterRetry.completedAt!.getTime()).toBeGreaterThanOrEqual(firstCompletedAt);
    });

    it('replaces file_issue_categories on retry rather than appending', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            {
              file_id: fx.sourceFiles[0].id,
              state: 'Failed',
              quality_label: 'Failed',
              issues_by_category: [
                { issue_category: 'old-issue', found: 5, fixed: 0, remaining: 5, issues: [] },
              ],
            },
          ],
        }),
        'responses/first.json',
      );

      let cats = await prisma.fileIssueCategory.findMany({});
      expect(cats).toHaveLength(1);
      expect(cats[0].category).toBe('old-issue');

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            {
              file_id: fx.sourceFiles[0].id,
              state: 'Completed',
              quality_label: 'Excellent',
              issues_by_category: [
                { issue_category: 'new-issue-a', found: 2, fixed: 2, remaining: 0, issues: [] },
                { issue_category: 'new-issue-b', found: 1, fixed: 1, remaining: 0, issues: [] },
              ],
            },
          ],
        }),
        'responses/retry.json',
      );

      cats = await prisma.fileIssueCategory.findMany({ orderBy: { category: 'asc' } });
      expect(cats).toHaveLength(2);
      expect(cats.map((c) => c.category)).toEqual(['new-issue-a', 'new-issue-b']);
    });
  });

  describe('dedup', () => {
    it('silently no-ops on duplicate s3 key (SQS at-least-once)', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      const payload = buildPayload({
        externalBatchId: fx.batchId,
        files: [{ file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' }],
      });

      await service.handleResults(fx.batchId, payload, 'responses/dup.json');
      await service.handleResults(fx.batchId, payload, 'responses/dup.json');

      const responses = await prisma.batchResponse.findMany({ where: { batchId: fx.batchId } });
      expect(responses).toHaveLength(1);

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.numRetries).toBe(0); // never advanced past first response
    });
  });

  describe('skipped files', () => {
    it('does not count skipped files toward succeeded/failed/requires_review', async () => {
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            { file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' },
            { file_id: fx.sourceFiles[1].id, state: 'Skipped', quality_label: 'Unchanged' },
          ],
        }),
        'responses/first.json',
      );

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.succeeded).toBe(1);
      expect(batch.failed).toBe(0);
      expect(batch.requiresReview).toBe(0);
      expect(batch.status).toBe('completed');
    });

    it('does not bucket Skipped+null-quality as failed (regression check)', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            { file_id: fx.sourceFiles[0].id, state: 'Skipped', quality_label: null },
          ],
        }),
        'responses/first.json',
      );

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.failed).toBe(0);
      // With only a skipped file, nothing is in any bucket — status falls
      // through to 'completed' (no failures, no warnings).
      expect(batch.status).toBe('completed');
    });
  });

  describe('rollups', () => {
    it('classifies RequiresReview-quality files as requires_review (not succeeded)', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            {
              file_id: fx.sourceFiles[0].id,
              state: 'Completed',
              quality_label: 'Requires Review',
            },
          ],
        }),
        'responses/first.json',
      );

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.requiresReview).toBe(1);
      expect(batch.succeeded).toBe(0);
      expect(batch.status).toBe('completed_with_warnings');
    });

    it('sums totalPages/totalIssuesFound/totalIssuesFixed across all settled files', async () => {
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            {
              file_id: fx.sourceFiles[0].id,
              state: 'Completed',
              quality_label: 'Excellent',
              total_pages: 5,
              total_issues_found: 8,
              total_issues_fixed: 8,
            },
            {
              file_id: fx.sourceFiles[1].id,
              state: 'Completed',
              quality_label: 'Good',
              total_pages: 3,
              total_issues_found: 4,
              total_issues_fixed: 3,
            },
          ],
        }),
        'responses/first.json',
      );

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.totalPages).toBe(8);
      expect(batch.totalIssuesFound).toBe(12);
      expect(batch.totalIssuesFixed).toBe(11);
    });
  });

  describe('unknown file_id', () => {
    it('logs and continues when response references an unknown file_id', async () => {
      const fx = await createBatchFixture([{ canvasFileId: '101', fileName: 'a.pdf' }]);

      // file_id 'ghost' is not in any of our batch_files. Handler should warn
      // and skip it; the known file should still be processed.
      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [
            { file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Excellent' },
            { file_id: 'ghost-id-not-in-batch', state: 'Completed', quality_label: 'Excellent' },
          ],
        }),
        'responses/first.json',
      );

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.succeeded).toBe(1);
      expect(batch.status).toBe('completed');
    });
  });

  describe('legacy batch backfill scenario', () => {
    it('does not corrupt a previously-terminal batch when a Connectivo retry arrives', async () => {
      // Simulates the post-deploy state: a batch was completed under the OLD
      // code path and has a synthetic 'legacy:' batch_responses row from the
      // migration backfill. A Connectivo retry now arrives.
      const fx = await createBatchFixture([
        { canvasFileId: '101', fileName: 'a.pdf' },
        { canvasFileId: '102', fileName: 'b.pdf' },
      ]);

      // Manually set state to mimic "already processed under old code": both
      // files completed.
      await prisma.batchFile.updateMany({
        where: { batchId: fx.batchId },
        data: { connectivoState: 'completed', qualityLabel: 'Excellent' },
      });
      await prisma.batch.update({
        where: { id: fx.batchId },
        data: { status: 'completed', succeeded: 2, failed: 0, requiresReview: 0 },
      });
      // Synthetic legacy batch_responses row (as the migration would have done).
      await prisma.batchResponse.create({
        data: { batchId: fx.batchId, s3Key: `legacy:${fx.batchId}`, connectivoBatchId: null },
      });

      // Now a retry comes in for file 1 only. file 2 should be untouched.
      await service.handleResults(
        fx.batchId,
        buildPayload({
          externalBatchId: fx.batchId,
          files: [{ file_id: fx.sourceFiles[0].id, state: 'Completed', quality_label: 'Good' }],
        }),
        'responses/retry-after-legacy.json',
      );

      const file2 = await prisma.batchFile.findFirstOrThrow({
        where: { batchId: fx.batchId, sourceFileId: fx.sourceFiles[1].id },
      });
      // CRITICAL: file 2 must NOT have been marked failed by missing-files logic.
      expect(file2.connectivoState).toBe('completed');
      expect(file2.qualityLabel).toBe('Excellent');

      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: fx.batchId } });
      expect(batch.succeeded).toBe(2);
      expect(batch.numRetries).toBe(1);
    });
  });
});
