import { describe, it, expect } from 'vitest';
import { parseAdminFilesQuery } from '@/services/accessHub/adminCourseFiles';

describe('parseAdminFilesQuery', () => {
  it('applies defaults', () => {
    const q = parseAdminFilesQuery({});
    expect(q.page).toBe(1);
    expect(q.page_size).toBe(20);
    expect(q.status).toBe('all');
    expect(q.sort).toBe('open_issues_desc');
    expect(q.hide_replaced_in_canvas).toBe(false);
    expect(q.canvas_term_id).toBeUndefined();
    expect(q.canvas_course_id).toBeUndefined();
    expect(q.q).toBeUndefined();
  });

  it('accepts all admin-specific params', () => {
    const q = parseAdminFilesQuery({
      canvas_term_id: 'SPRING2026',
      canvas_course_id: 'canvas-abc',
      q: 'lecture',
      status: 'in_progress',
      hide_replaced_in_canvas: 'true',
      sort: 'display_name_asc',
      page: '2',
      page_size: '10',
    });
    expect(q.canvas_term_id).toBe('SPRING2026');
    expect(q.canvas_course_id).toBe('canvas-abc');
    expect(q.q).toBe('lecture');
    expect(q.status).toBe('in_progress');
    expect(q.hide_replaced_in_canvas).toBe(true);
    expect(q.sort).toBe('display_name_asc');
    expect(q.page).toBe(2);
    expect(q.page_size).toBe(10);
  });

  it('throws 400 for invalid status', () => {
    expect(() => parseAdminFilesQuery({ status: 'unknown' })).toThrow();
  });

  it('throws 400 for page < 1', () => {
    expect(() => parseAdminFilesQuery({ page: '0' })).toThrow();
  });

  it('throws 400 for page_size > 100', () => {
    expect(() => parseAdminFilesQuery({ page_size: '200' })).toThrow();
  });
});
