# One-time bootstrap: creates the S3 bucket + DynamoDB table that back Terraform state
# for every environment, the GitHub OIDC provider, and the account-level shared
# accesshub-videos bucket. Run this once per AWS account, before anything in envs/*.
#
# After `terraform apply` here, edit envs/dev/backend.tf with the bucket/table names.
#
# This stack itself is stored locally — bootstrap.tfstate lives next to this file.
# Commit it? No. It only holds the bucket + table names, which are non-sensitive,
# but the usual advice is to keep it in 1Password / a private note and move on.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "aws_profile" {
  description = "AWS named profile to use"
  type        = string
  default     = "sparient"
}

variable "state_bucket_name" {
  description = "Globally-unique name for the Terraform state bucket"
  type        = string
  # No default — you must choose one (buckets are globally unique).
}

variable "lock_table_name" {
  description = "DynamoDB table used for Terraform state locking"
  type        = string
  default     = "sparient-tf-locks"
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "lock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

# GitHub Actions OIDC provider — account-level singleton. Both envs (single, dev) reference
# this via a data lookup so neither env tries to recreate it.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# --- Explainer-video bucket (account-level shared asset) ---
# Holds the videos that map to Connectivo issue names (see videos / error_keywords tables).
# Public-read objects so the FE can use plain https URLs in <video> tags. Lives in bootstrap
# (not in any env) so dev and prod both just reference it by ARN — and tearing down either
# env leaves it untouched.
resource "aws_s3_bucket" "accesshub_videos" {
  bucket = "accesshub-videos"
}

# Block public ACLs (legacy/risky) but allow bucket policies that grant public read.
resource "aws_s3_bucket_public_access_block" "accesshub_videos" {
  bucket                  = aws_s3_bucket.accesshub_videos.id
  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "accesshub_videos_public_read" {
  statement {
    sid       = "PublicReadGetObject"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.accesshub_videos.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "accesshub_videos_public_read" {
  bucket = aws_s3_bucket.accesshub_videos.id
  policy = data.aws_iam_policy_document.accesshub_videos_public_read.json
  # The public-access block must be relaxed before the policy is accepted.
  depends_on = [aws_s3_bucket_public_access_block.accesshub_videos]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "accesshub_videos" {
  bucket = aws_s3_bucket.accesshub_videos.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CORS so browsers can fetch the videos cross-origin (needed if the FE uses fetch()
# or Range requests via XHR; not strictly needed for a plain <video src="..."> tag,
# but harmless and avoids surprises if the FE later switches to fetch-based playback).
resource "aws_s3_bucket_cors_configuration" "accesshub_videos" {
  bucket = aws_s3_bucket.accesshub_videos.id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Range"]
    max_age_seconds = 3600
  }
}

output "state_bucket_name" { value = aws_s3_bucket.state.id }
output "lock_table_name" { value = aws_dynamodb_table.lock.name }
output "region" { value = var.region }
output "github_oidc_provider_arn" { value = aws_iam_openid_connect_provider.github.arn }
output "accesshub_videos_bucket" { value = aws_s3_bucket.accesshub_videos.id }
