// All four "buckets" are prefixes within a single S3 bucket.
// TODO: bucket name is hardcoded to sparient-remediation-testing — make configurable for prod.
export const S3_PREFIX = {
  SOURCE:    'connectivo-incoming',
  REMEDIATED: 'connectivo-remediated',
  REQUESTS:  'sparient-remediation-requests',
  RESPONSES: 'sparient-remediation-responses',
} as const;
