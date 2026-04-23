// Resolves the S3 bucket name for an institution.
// Convention: sparient-<institutionId>. Override: institution.s3Bucket column.
export function getBucketName(institutionId: string, s3BucketOverride?: string | null): string {
  return s3BucketOverride ?? `sparient-${institutionId}`;
}
