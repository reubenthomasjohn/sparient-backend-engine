import { describe, it, expect } from 'vitest';
import { S3_PREFIX } from '../../../src/config/s3Prefixes';
import {
  getDefaultS3LayoutConfig,
  getEffectiveS3LayoutConfig,
  resolveResponseObjectKey,
} from '../../../src/config/s3LayoutConfig';

describe('s3LayoutConfig', () => {
  it('getDefaultS3LayoutConfig matches S3_PREFIX', () => {
    expect(getDefaultS3LayoutConfig()).toEqual({
      sourcePrefix: S3_PREFIX.SOURCE,
      remediatedPrefix: S3_PREFIX.REMEDIATED,
      requestsPrefix: S3_PREFIX.REQUESTS,
      responsesPrefix: S3_PREFIX.RESPONSES,
    });
  });

  it('getEffectiveS3LayoutConfig falls back to defaults when null', () => {
    expect(getEffectiveS3LayoutConfig({ id: 'inst-1', s3LayoutConfig: null })).toEqual(
      getDefaultS3LayoutConfig(),
    );
  });

  it('getEffectiveS3LayoutConfig uses stored snapshot', () => {
    const stored = {
      sourcePrefix: 'connectivo-incoming',
      remediatedPrefix: 'connectivo-incoming-remediated',
      requestsPrefix: 'sparient-remediation-requests',
      responsesPrefix: 'connectivo-remediation-response',
    };
    expect(getEffectiveS3LayoutConfig({ id: 'inst-1', s3LayoutConfig: stored })).toEqual(stored);
  });

  it('resolveResponseObjectKey prepends prefix for bare filenames', () => {
    expect(resolveResponseObjectKey('batch.json', 'connectivo-remediation-response')).toBe(
      'connectivo-remediation-response/batch.json',
    );
  });

  it('resolveResponseObjectKey leaves full keys unchanged', () => {
    const key = 'connectivo-remediation-response/20260629_job_completed-abc.json';
    expect(resolveResponseObjectKey(key, 'connectivo-remediation-response')).toBe(key);
  });
});
