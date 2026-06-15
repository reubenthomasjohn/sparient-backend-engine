import { describe, it, expect } from 'vitest';
import { serializeCanvasParams } from '../../../src/services/sources/canvas/CanvasClient';

describe('serializeCanvasParams', () => {
  it('brackets array params so Rails parses them as arrays (the core discovery bug)', () => {
    // Without [] Rails collapses repeated keys to the last value, so
    // state=available&state=unpublished becomes a scalar "unpublished" -> 0 courses.
    expect(serializeCanvasParams({ state: ['available', 'claimed'] })).toBe(
      'state%5B%5D=available&state%5B%5D=claimed',
    );
  });

  it('does not double-bracket a key that already ends with []', () => {
    expect(serializeCanvasParams({ 'content_types[]': ['application/pdf', 'image/png'] })).toBe(
      'content_types%5B%5D=application%2Fpdf&content_types%5B%5D=image%2Fpng',
    );
  });

  it('passes scalars through unchanged', () => {
    expect(serializeCanvasParams({ per_page: 100, enrollment_term_id: '2152' })).toBe(
      'per_page=100&enrollment_term_id=2152',
    );
  });

  it('skips null/undefined values', () => {
    expect(serializeCanvasParams({ a: 1, b: null, c: undefined })).toBe('a=1');
  });
});
