# --- CSUF: cross-account access to their externally-owned institution bucket ---
#
# csufit-infra-canvas-ati lives in CSUF's AWS account, not ours. Cross-account S3
# access requires BOTH sides to allow: CSUF attaches a bucket policy granting this
# role, and this statement is our (identity) half. The institution row's s3Bucket
# column is set to "csufit-infra-canvas-ati" so the pipeline reads/writes there.
#
# Attached to the shared lambda_exec role as a separate inline policy so this
# tenant-specific grant stays isolated from the shared runtime policy in main.tf.

data "aws_iam_policy_document" "csuf_bucket" {
  # Full S3 access, scoped to just this bucket. Two ARNs: the bare bucket ARN for
  # bucket-level actions (ListBucket, ...) and /* for object actions (Get/Put/...).
  statement {
    sid     = "CsufBucketFullAccess"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::csufit-infra-canvas-ati",
      "arn:aws:s3:::csufit-infra-canvas-ati/*",
    ]
  }

  # If the bucket is encrypted with a CSUF-owned KMS CMK (SSE-KMS, not SSE-S3/
  # AES256), uncomment and set their key ARN — and have CSUF grant this role the
  # same on their key policy. Leave commented for SSE-S3 buckets.
  # statement {
  #   sid       = "CsufBucketKms"
  #   actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
  #   resources = ["arn:aws:kms:us-west-2:<CSUF_ACCOUNT_ID>:key/<KEY_ID>"]
  # }
}

resource "aws_iam_role_policy" "csuf_bucket" {
  name   = "${var.name_prefix}-csuf-bucket-access"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.csuf_bucket.json
}
