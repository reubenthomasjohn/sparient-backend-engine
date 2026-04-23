import { describe, it, expect } from 'vitest';
import { parseReplaceBody } from '@/services/accessHub/courseFileReplace';

const VALID_UUID = '33333333-3333-3333-3333-333333333333';

describe('parseReplaceBody', () => {
  it('accepts a valid UUID', () => {
    const body = parseReplaceBody({ batch_file_id: VALID_UUID });
    expect(body.batch_file_id).toBe(VALID_UUID);
  });

  it('throws 400 when batch_file_id is missing', () => {
    expect(() => parseReplaceBody({})).toThrow();
    expect(() => parseReplaceBody(null)).toThrow();
  });

  it('throws 400 when batch_file_id is not a UUID', () => {
    expect(() => parseReplaceBody({ batch_file_id: 'not-a-uuid' })).toThrow();
    expect(() => parseReplaceBody({ batch_file_id: 123 })).toThrow();
    expect(() => parseReplaceBody({ batch_file_id: '' })).toThrow();
  });
});
