import { config } from './index';

// Resolves the S3 bucket name for an institution at READ time.
// Override (institution.s3Bucket) wins — registration stores the resolved name there,
// so existing rows always resolve via the stored value. The sparient-<institutionId>
// fallback is kept for legacy rows that predate the slug-based naming.
export function getBucketName(institutionId: string, s3BucketOverride?: string | null): string {
  return s3BucketOverride ?? `sparient-${institutionId}`;
}

// Deterministic per-institution bucket name from the (unique, immutable) slug, used at
// registration time: <prefix>-<slug>, e.g. sparient-prod-accesshub-acme. Being derived
// from the slug (not a random id) makes provisioning idempotent — a retry reuses the same
// bucket rather than orphaning a new one. The resolved name is stored in s3Bucket so reads
// stay stable even if the prefix convention later changes.
export function getInstitutionBucketName(slug: string): string {
  const name = `${config.storage.institutionBucketPrefix}-${slug}`;
  // S3 bucket names are capped at 63 chars. The slug is length-capped at the API, but
  // guard here too so a misconfigured prefix fails loudly instead of at the S3 call.
  if (name.length > 63) {
    throw new Error(
      `Computed bucket name "${name}" exceeds the 63-char S3 limit; shorten the slug or the INSTITUTION_BUCKET_PREFIX.`,
    );
  }
  return name;
}
