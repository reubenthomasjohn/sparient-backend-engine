import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

vi.mock('../../../src/workers/writeback/handler', () => ({ handleWritebackJob: vi.fn() }));

import { handler } from '../../../src/workers/writeback/lambda';
import { handleWritebackJob } from '../../../src/workers/writeback/handler';

function event(bodies: string[]): SQSEvent {
  return { Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) } as unknown as SQSEvent;
}

beforeEach(() => vi.mocked(handleWritebackJob).mockReset());

describe('writeback lambda', () => {
  it('drops an unparseable (poison) body WITHOUT a batch-item failure — no redrive', async () => {
    const res = await handler(event(['{ not json']));
    expect(res.batchItemFailures).toEqual([]);
    expect(handleWritebackJob).not.toHaveBeenCalled();
  });

  it('reports a batch-item failure when the handler throws (transient -> redrive)', async () => {
    vi.mocked(handleWritebackJob).mockRejectedValueOnce(new Error('boom'));
    const res = await handler(event([JSON.stringify({ batchFileId: 'bf-1' })]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm0' }]);
  });

  it('no failures when the handler resolves; forwards the parsed job', async () => {
    vi.mocked(handleWritebackJob).mockResolvedValue(undefined);
    const res = await handler(event([JSON.stringify({ batchFileId: 'bf-1', ignoreOptIn: true })]));
    expect(res.batchItemFailures).toEqual([]);
    expect(handleWritebackJob).toHaveBeenCalledWith({ batchFileId: 'bf-1', ignoreOptIn: true });
  });

  it('isolates records: a poison body is dropped while a valid one still processes', async () => {
    vi.mocked(handleWritebackJob).mockResolvedValue(undefined);
    const res = await handler(event(['{bad', JSON.stringify({ batchFileId: 'bf-2' })]));
    expect(res.batchItemFailures).toEqual([]);
    expect(handleWritebackJob).toHaveBeenCalledTimes(1);
    expect(handleWritebackJob).toHaveBeenCalledWith({ batchFileId: 'bf-2' });
  });
});
