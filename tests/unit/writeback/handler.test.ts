import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prismaMock } from '../../setup';
import { handleWritebackJob } from '../../../src/workers/writeback/handler';
import { writebackService } from '../../../src/services/writeback/WritebackService';

vi.mock('../../../src/services/writeback/WritebackService', () => ({
  writebackService: { writeBack: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(writebackService.writeBack).mockReset();
});

describe('handleWritebackJob', () => {
  it('passes the batchFileId straight through on success', async () => {
    vi.mocked(writebackService.writeBack).mockResolvedValue(undefined);
    await handleWritebackJob({ batchFileId: 'bf-1' });
    expect(writebackService.writeBack).toHaveBeenCalledWith('bf-1', {
      ignoreOptIn: undefined,
      sourceFileId: undefined,
    });
    expect(prismaMock.sourceFile.updateMany).not.toHaveBeenCalled();
  });

  it('rethrows on error so SQS can redrive', async () => {
    vi.mocked(writebackService.writeBack).mockRejectedValue(new Error('canvas down'));
    prismaMock.batchFile.findUnique.mockResolvedValue({ sourceFileId: 'sf-1' } as any);

    await expect(handleWritebackJob({ batchFileId: 'bf-1' })).rejects.toThrow('canvas down');
  });

  it('records writebackState=failed via guarded updateMany (does not overwrite written/skipped_stale)', async () => {
    vi.mocked(writebackService.writeBack).mockRejectedValue(new Error('boom'));
    prismaMock.batchFile.findUnique.mockResolvedValue({ sourceFileId: 'sf-1' } as any);

    await expect(handleWritebackJob({ batchFileId: 'bf-1' })).rejects.toThrow();

    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'sf-1',
        OR: [
          { writebackState: null },
          { writebackState: 'failed' },
          { writebackState: 'queued' },
          { writebackState: 'in_progress' },
        ],
      },
      data: { writebackState: 'failed' },
    });
  });

  it('forwards ignoreOptIn and sourceFileId from the job to the service (manual replace path)', async () => {
    vi.mocked(writebackService.writeBack).mockResolvedValue(undefined);
    await handleWritebackJob({ batchFileId: 'bf-1', ignoreOptIn: true, sourceFileId: 'sf-1' });
    expect(writebackService.writeBack).toHaveBeenCalledWith('bf-1', {
      ignoreOptIn: true,
      sourceFileId: 'sf-1',
    });
  });

  it('does NOT redrive a permanent error (Canvas 4xx) — stamps failed and swallows', async () => {
    const permanent = Object.assign(new Error('forbidden'), {
      isAxiosError: true,
      response: { status: 403 },
    });
    vi.mocked(writebackService.writeBack).mockRejectedValue(permanent);
    prismaMock.batchFile.findUnique.mockResolvedValue({ sourceFileId: 'sf-1' } as any);

    // Resolves (no throw) so the SQS lambda deletes the message instead of redriving to DLQ.
    await expect(handleWritebackJob({ batchFileId: 'bf-1' })).resolves.toBeUndefined();
    expect(prismaMock.sourceFile.updateMany).toHaveBeenCalled(); // still stamped failed
  });

  it('DOES redrive a transient error (Canvas 429)', async () => {
    const transient = Object.assign(new Error('rate limited'), {
      isAxiosError: true,
      response: { status: 429 },
    });
    vi.mocked(writebackService.writeBack).mockRejectedValue(transient);
    prismaMock.batchFile.findUnique.mockResolvedValue({ sourceFileId: 'sf-1' } as any);

    await expect(handleWritebackJob({ batchFileId: 'bf-1' })).rejects.toThrow();
  });

  it('swallows secondary DB errors during failure recording (still rethrows the original)', async () => {
    vi.mocked(writebackService.writeBack).mockRejectedValue(new Error('original'));
    prismaMock.batchFile.findUnique.mockRejectedValue(new Error('db blip'));

    await expect(handleWritebackJob({ batchFileId: 'bf-1' })).rejects.toThrow('original');
  });
});
