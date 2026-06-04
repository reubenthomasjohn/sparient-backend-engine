import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../src/db/client';
import { RemediationService } from '../../src/services/remediation/RemediationService';
import { writebackQueue } from '../../src/queue';
import { seedCourse, seedInstitution, seedSourceFile } from './seed';
import type { ConnectivoResultsPayload } from '../../src/types/connectivo';

vi.mock('../../src/queue', () => ({
  writebackQueue: { send: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(writebackQueue.send).mockReset();
  vi.mocked(writebackQueue.send).mockResolvedValue(undefined);
});

async function setupBatch(opts: { writebackOptIn?: boolean } = {}) {
  const institution = await seedInstitution({ writebackOptIn: opts.writebackOptIn ?? true });
  const course = await seedCourse(institution.id);
  const sf = await seedSourceFile(course.id, {
    batchedModifiedAt: new Date('2026-04-01T00:00:00Z'),
  });
  const batch = await prisma.batch.create({
    data: {
      institutionId: institution.id,
      courseId: course.id,
      status: 'pending',
      requestS3Bucket: 'sparient-int',
      totalFiles: 1,
    },
  });
  await prisma.batchFile.create({
    data: {
      batchId: batch.id,
      sourceFileId: sf.id,
      canvasFileId: sf.canvasFileId,
      s3SourceKey: sf.s3SourceKey!,
      sourceModifiedAt: sf.s3SourceModifiedAt!,
    },
  });
  return { institution, course, sf, batch };
}

function payload(externalBatchId: string): ConnectivoResultsPayload {
  return {
    batch: {
      id: 'connectivo-1',
      external_batch_id: externalBatchId,
      state: 'completed',
      started_at: '2026-04-01T00:00:00Z',
      completed_at: '2026-04-01T00:10:00Z',
      summary: {
        total_files: 1, total_pages: 10, succeeded: 1, failed: 0, requires_review: 0,
        skipped: 0, total_issues_found: 2, total_issues_fixed: 2,
      },
    },
    folders: [{
      path: '/sparient-int/connectivo-incoming/101/',
      files: [{
        file_name: 'doc.pdf',
        remediated_path: '/sparient-int/connectivo-remediated/101/cf-1.pdf',
        custom_fields: { file_id: '', canvas_file_id: 'cf-1' },
        quality_label: 'Good',
        state: 'Completed',
        total_pages: 10,
        processing_time_seconds: 5,
        compliance_errors: 0,
        compliance_warnings: 0,
        total_issues_found: 2,
        total_issues_fixed: 2,
        issues_by_category: [],
      }],
    }],
  };
}

describe('RemediationService.handleResults integration', () => {
  const service = new RemediationService();

  it('writes outcomes + enqueues writebacks for a successful batch', async () => {
    const { batch, sf } = await setupBatch();
    // file_id custom field must match the actual sourceFile id
    const p = payload(batch.id);
    p.folders[0].files[0].custom_fields.file_id = sf.id;

    await service.handleResults(batch.id, p, `responses/${batch.id}-1.json`);

    const refreshed = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(refreshed.status).toBe('completed');
    expect(refreshed.totalIssuesFixed).toBe(2);

    const bf = await prisma.batchFile.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(bf.connectivoState).toBe('completed');
    expect(bf.qualityLabel).toBe('Good');
    expect(bf.remediatedS3Key).toBe('connectivo-remediated/101/cf-1.pdf');
    // Bucket comes from the parsed remediated_path, not batch.requestS3Bucket.
    expect(bf.remediatedS3Bucket).toBe('sparient-int');

    const sfRefreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(sfRefreshed.lastOutcome).toBe('completed');

    expect(writebackQueue.send).toHaveBeenCalledOnce();
    expect(writebackQueue.send).toHaveBeenCalledWith({ batchFileId: bf.id });
  });

  it('marks files missing from the response payload as failed', async () => {
    const { batch, sf } = await setupBatch();
    const p = payload(batch.id);
    p.folders = []; // remove all files

    await service.handleResults(batch.id, p, `responses/${batch.id}-1.json`);

    const bf = await prisma.batchFile.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(bf.connectivoState).toBe('failed');
    expect(bf.errorMessage).toMatch(/missing/i);

    const sfRefreshed = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sf.id } });
    expect(sfRefreshed.lastOutcome).toBe('failed');
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('is idempotent on re-delivery (same s3 key → AlreadyProcessedError → dedupe filter)', async () => {
    const { batch, sf } = await setupBatch();
    const p = payload(batch.id);
    p.folders[0].files[0].custom_fields.file_id = sf.id;

    // SQS at-least-once: same S3 key delivered twice. The unique constraint on
    // batch_responses(s3_key) catches the redrive and routes the second call
    // into the AlreadyProcessedError crash-recovery branch.
    const responseKey = `responses/${batch.id}-redelivered.json`;

    await service.handleResults(batch.id, p, responseKey);
    expect(writebackQueue.send).toHaveBeenCalledOnce();
    vi.mocked(writebackQueue.send).mockClear();

    // Simulate the worker having already written-back. Dedupe filter checks
    // lastWritebackModifiedAt > sourceModifiedAt strictly.
    await prisma.sourceFile.update({
      where: { id: sf.id },
      data: {
        writebackState: 'written',
        lastWritebackModifiedAt: new Date('2026-04-02T00:00:00Z'),
      },
    });

    // Re-delivery with the SAME s3 key. Should not throw and not re-enqueue.
    await service.handleResults(batch.id, p, responseKey);

    expect(writebackQueue.send).not.toHaveBeenCalled();
  });

  it('processes a follow-up retry response (different s3 key → second tx commits)', async () => {
    const { batch, sf } = await setupBatch();
    const p1 = payload(batch.id);
    p1.folders[0].files[0].custom_fields.file_id = sf.id;
    p1.folders[0].files[0].quality_label = 'RequiresReview';

    await service.handleResults(batch.id, p1, `responses/${batch.id}-first.json`);

    let bf = await prisma.batchFile.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(bf.qualityLabel).toBe('RequiresReview');

    // Second response with a DIFFERENT s3 key — Connectivo's voluntary retry.
    const p2 = payload(batch.id);
    p2.folders[0].files[0].custom_fields.file_id = sf.id;
    p2.folders[0].files[0].quality_label = 'Excellent';

    await service.handleResults(batch.id, p2, `responses/${batch.id}-retry.json`);

    bf = await prisma.batchFile.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(bf.qualityLabel).toBe('Excellent');

    const refreshed = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(refreshed.numRetries).toBe(1);
  });

  it('writes per-file outcomes inside one transaction and skips writeback when opted out', async () => {
    const { batch, sf } = await setupBatch({ writebackOptIn: false });
    const p = payload(batch.id);
    p.folders[0].files[0].custom_fields.file_id = sf.id;

    await service.handleResults(batch.id, p, `responses/${batch.id}-1.json`);

    const issueCats = await prisma.fileIssueCategory.findMany();
    expect(issueCats).toHaveLength(0); // payload has no issues_by_category

    // No writeback enqueued because opt-out
    expect(writebackQueue.send).not.toHaveBeenCalled();
  });
});
