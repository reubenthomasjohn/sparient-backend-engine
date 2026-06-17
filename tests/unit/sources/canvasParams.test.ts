import { describe, it, expect } from 'vitest';
import axios from 'axios';
import {
  serializeCanvasParams,
  redactCanvasAuthError,
} from '../../../src/services/sources/canvas/CanvasClient';

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

describe('redactCanvasAuthError', () => {
  it('redacts the Bearer token from AxiosHeaders config, keeping other headers', () => {
    const headers = axios.AxiosHeaders.from({
      Authorization: 'Bearer super-secret-token',
      'Content-Type': 'application/json',
    });
    const err = { config: { headers } };
    redactCanvasAuthError(err);
    expect(headers.get('Authorization')).toBe('[REDACTED]');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('redacts plain-object headers (case-insensitive key)', () => {
    const err = { config: { headers: { authorization: 'Bearer x', accept: 'json' } } };
    redactCanvasAuthError(err);
    expect(err.config.headers.authorization).toBe('[REDACTED]');
    expect(err.config.headers.accept).toBe('json');
  });

  it('also scrubs response.config.headers and returns the same error object', () => {
    const err = {
      config: { headers: { Authorization: 'Bearer a' } },
      response: { config: { headers: { Authorization: 'Bearer b' } } },
    };
    const out = redactCanvasAuthError(err);
    expect(out).toBe(err);
    expect(err.config.headers.Authorization).toBe('[REDACTED]');
    expect(err.response.config.headers.Authorization).toBe('[REDACTED]');
  });

  it('no-ops safely when there is no config/headers', () => {
    expect(() => redactCanvasAuthError(new Error('boom'))).not.toThrow();
    expect(() => redactCanvasAuthError(undefined)).not.toThrow();
  });

  it('the redacted token never appears in JSON.stringify of the error config', () => {
    const headers = axios.AxiosHeaders.from({ Authorization: 'Bearer leak-me' });
    const err = { config: { headers } };
    redactCanvasAuthError(err);
    expect(JSON.stringify(err.config.headers)).not.toContain('leak-me');
  });
});
