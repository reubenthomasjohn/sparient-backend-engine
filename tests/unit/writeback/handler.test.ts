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
    expect(writebackService.writeBack).toHaveBeenCalledWith('bf-1');
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
        OR: [{ writebackState: null }, { writebackState: 'failed' }],
      },
      data: { writebackState: 'failed' },
    });
  });

  it('swallows secondary DB errors during failure recording (still rethrows the original)', async () => {
    vi.mocked(writebackService.writeBack).mockRejectedValue(new Error('original'));
    prismaMock.batchFile.findUnique.mockRejectedValue(new Error('db blip'));

    await expect(handleWritebackJob({ batchFileId: 'bf-1' })).rejects.toThrow('original');
  });
});
