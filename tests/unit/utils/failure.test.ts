import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeFailureUpdate } from '../../../src/utils/failure';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computeFailureUpdate', () => {
  it('first failure: outcome=failed, retryCount=1, nextRetryAt set', () => {
    const r = computeFailureUpdate({ retryCount: 0, maxRetries: 3 }, 'boom');
    expect(r.lastOutcome).toBe('failed');
    expect(r.retryCount).toBe(1);
    expect(r.nextRetryAt).not.toBeNull();
  });

  it('marks permanently_failed once retries are exhausted', () => {
    const r = computeFailureUpdate({ retryCount: 2, maxRetries: 3 }, 'boom');
    expect(r.lastOutcome).toBe('permanently_failed');
    expect(r.retryCount).toBe(3);
    expect(r.nextRetryAt).toBeNull();
  });

  it('exponential backoff: each retry is 4x the previous', () => {
    const a = computeFailureUpdate({ retryCount: 0, maxRetries: 5 }, 'x').nextRetryAt!;
    const b = computeFailureUpdate({ retryCount: 1, maxRetries: 5 }, 'x').nextRetryAt!;
    const c = computeFailureUpdate({ retryCount: 2, maxRetries: 5 }, 'x').nextRetryAt!;

    const da = a.getTime() - Date.now();
    const db = b.getTime() - Date.now();
    const dc = c.getTime() - Date.now();
    expect(db / da).toBeCloseTo(4);
    expect(dc / db).toBeCloseTo(4);
  });

  it('records the failure reason verbatim', () => {
    const r = computeFailureUpdate({ retryCount: 0, maxRetries: 3 }, 'specific error');
    expect(r.lastFailureReason).toBe('specific error');
  });
});
