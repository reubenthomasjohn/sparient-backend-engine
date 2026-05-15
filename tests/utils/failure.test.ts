import { describe, it, expect } from 'vitest';
import { computeFailureUpdate } from '../../src/utils/failure';
import { config } from '../../src/config';

// computeFailureUpdate is a pure function. Driven entirely by the
// { retryCount, maxRetries } slice of SourceFile plus a reason string.
const sf = (retryCount: number, maxRetries = 3) => ({ retryCount, maxRetries });

const baseDelayMs = config.jobs.retryBaseDelayMinutes * 60 * 1000;

describe('computeFailureUpdate', () => {
  describe('non-permanent failures (retryCount + 1 < maxRetries)', () => {
    it('marks lastOutcome=failed on the first failure', () => {
      const result = computeFailureUpdate(sf(0), 'first failure');
      expect(result.lastOutcome).toBe('failed');
      expect(result.retryCount).toBe(1);
      expect(result.lastFailureReason).toBe('first failure');
      expect(result.nextRetryAt).toBeInstanceOf(Date);
    });

    it('schedules the first retry at base delay × 4^0 = base delay', () => {
      const before = Date.now();
      const result = computeFailureUpdate(sf(0), 'reason');
      const after = Date.now();
      const delay = result.nextRetryAt!.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(baseDelayMs);
      // Allow some slack for time between Date.now() calls.
      expect(delay).toBeLessThanOrEqual(baseDelayMs + (after - before) + 10);
    });

    it('schedules the second retry at base delay × 4', () => {
      const before = Date.now();
      const result = computeFailureUpdate(sf(1), 'reason');
      const delay = result.nextRetryAt!.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(baseDelayMs * 4);
      expect(delay).toBeLessThanOrEqual(baseDelayMs * 4 + 50);
    });

    it('increments retryCount monotonically', () => {
      expect(computeFailureUpdate(sf(0), 'r').retryCount).toBe(1);
      expect(computeFailureUpdate(sf(1), 'r').retryCount).toBe(2);
      expect(computeFailureUpdate(sf(2), 'r').retryCount).toBe(3);
    });
  });

  describe('permanent failure (retryCount + 1 >= maxRetries)', () => {
    it('marks permanently_failed when the new count reaches maxRetries', () => {
      // maxRetries = 3, retryCount = 2 → newCount = 3 → permanent
      const result = computeFailureUpdate(sf(2, 3), 'last straw');
      expect(result.lastOutcome).toBe('permanently_failed');
      expect(result.retryCount).toBe(3);
      expect(result.nextRetryAt).toBeNull();
    });

    it('marks permanently_failed even past maxRetries (defensive)', () => {
      const result = computeFailureUpdate(sf(10, 3), 'reason');
      expect(result.lastOutcome).toBe('permanently_failed');
      expect(result.nextRetryAt).toBeNull();
    });

    it('respects a custom maxRetries', () => {
      // Lower bound: maxRetries=1 means the very first failure is permanent.
      const result = computeFailureUpdate(sf(0, 1), 'one-shot');
      expect(result.lastOutcome).toBe('permanently_failed');
      expect(result.retryCount).toBe(1);
      expect(result.nextRetryAt).toBeNull();
    });

    it('schedules a retry when maxRetries is higher than default', () => {
      // maxRetries=5, retryCount=2 → newCount=3, not yet permanent
      const result = computeFailureUpdate(sf(2, 5), 'reason');
      expect(result.lastOutcome).toBe('failed');
      expect(result.nextRetryAt).toBeInstanceOf(Date);
    });
  });

  describe('reason passthrough', () => {
    it('stores the supplied reason verbatim', () => {
      const result = computeFailureUpdate(sf(0), 'S3 putObject timeout after 30s');
      expect(result.lastFailureReason).toBe('S3 putObject timeout after 30s');
    });
  });
});
