import { describe, it, expect } from 'vitest';
import { parseScannedCoursesQuery } from '@/services/accessHub/adminScannedCourses';

describe('parseScannedCoursesQuery', () => {
  it('applies defaults', () => {
    const q = parseScannedCoursesQuery({});
    expect(q.page).toBe(1);
    expect(q.page_size).toBe(20);
    expect(q.q).toBeUndefined();
    expect(q.canvas_term_id).toBeUndefined();
  });

  it('accepts valid params', () => {
    const q = parseScannedCoursesQuery({
      page: '3',
      page_size: '50',
      q: 'bio',
      canvas_term_id: 'term-2026',
    });
    expect(q.page).toBe(3);
    expect(q.page_size).toBe(50);
    expect(q.q).toBe('bio');
    expect(q.canvas_term_id).toBe('term-2026');
  });

  it('throws 400 for page < 1', () => {
    expect(() => parseScannedCoursesQuery({ page: '0' })).toThrow();
  });

  it('throws 400 for page_size > 100', () => {
    expect(() => parseScannedCoursesQuery({ page_size: '101' })).toThrow();
  });

  it('throws 400 for non-integer page', () => {
    expect(() => parseScannedCoursesQuery({ page: 'abc' })).toThrow();
  });
});
