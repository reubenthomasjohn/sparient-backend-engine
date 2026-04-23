// All four "folders" are prefixes within each institution's S3 bucket.
export const S3_PREFIX = {
  SOURCE:    'connectivo-incoming',
  REMEDIATED: 'connectivo-remediated',
  REQUESTS:  'sparient-remediation-requests',
  RESPONSES: 'sparient-remediation-responses',
} as const;
