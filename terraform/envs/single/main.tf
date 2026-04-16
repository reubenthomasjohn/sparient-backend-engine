provider "aws" {
  region  = var.region
  profile = var.aws_profile
}

provider "neon" {
  api_key = var.neon_api_key
}

data "aws_caller_identity" "current" {}

locals {
  github_repo_full = "${var.github_owner}/${var.github_repo_name}"
}

# --- Neon Postgres ---
# Creates a project + default branch + database + role. The connection URI is exported
# directly by the provider and passed into the Lambda env.
resource "neon_project" "this" {
  name       = var.name_prefix
  region_id  = var.neon_region
  pg_version = 16
}

# --- Connectivo S3 buckets ---
resource "aws_s3_bucket" "requests" {
  bucket = "sparient-remediation-requests"
}

resource "aws_s3_bucket" "responses" {
  bucket = "sparient-remediation-responses"
}

resource "aws_s3_bucket_public_access_block" "requests" {
  bucket                  = aws_s3_bucket.requests.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "responses" {
  bucket                  = aws_s3_bucket.responses.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- ECR ---
resource "aws_ecr_repository" "this" {
  name                 = "sparient-monolith"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# --- Lambda execution role ---
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "runtime" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      "arn:aws:s3:::${var.s3_source_bucket}/*",
      "arn:aws:s3:::${var.s3_remediated_bucket}/*",
      "${aws_s3_bucket.requests.arn}/*",
      "${aws_s3_bucket.responses.arn}/*",
    ]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [
      "arn:aws:s3:::${var.s3_source_bucket}",
      "arn:aws:s3:::${var.s3_remediated_bucket}",
      aws_s3_bucket.requests.arn,
      aws_s3_bucket.responses.arn,
    ]
  }
}

resource "aws_iam_role_policy" "runtime" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.runtime.json
}

# --- Lambda ---
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name_prefix}"
  retention_in_days = 14
}

# Placeholder image URI — Terraform creates the Lambda pointing at a well-known "hello world"
# base image the very first time. CI/CD (deploy-single.yml) replaces the image on every push.
# The aws_lambda_function.image_uri is set with a lifecycle.ignore_changes so terraform does
# not try to revert it after CI has updated it.
resource "aws_lambda_function" "this" {
  function_name = var.name_prefix
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.this.repository_url}:bootstrap"
  architectures = ["arm64"]
  timeout       = var.timeout_seconds
  memory_size   = var.memory_mb

  environment {
    variables = {
      NODE_ENV                            = "production"
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
      DATABASE_URL                        = neon_project.this.connection_uri
      S3_SOURCE_BUCKET                    = var.s3_source_bucket
      S3_REMEDIATED_BUCKET                = var.s3_remediated_bucket
      QUEUE_START_CONSUMERS               = "false"
      S3_REQUESTS_BUCKET                  = aws_s3_bucket.requests.id
      S3_RESPONSES_BUCKET                 = aws_s3_bucket.responses.id
    }
  }

  lifecycle {
    ignore_changes = [image_uri] # CI owns image rollouts after the first apply
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["*"]
    allow_methods = ["*"]
    allow_headers = ["*"]
  }
}

# ------------------------------------------------------------------------------
# GitHub Actions OIDC: lets the CI workflow assume a role to build, push, and
# update the Lambda without storing long-lived AWS keys in GitHub.
# The OIDC provider itself is account-level and lives in terraform/bootstrap.
# ------------------------------------------------------------------------------
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # Only the configured deploy branch of the configured repo can assume this role.
      values   = ["repo:${local.github_repo_full}:ref:refs/heads/${var.github_deploy_branch}"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${var.name_prefix}-github-actions"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_actions" {
  # Push images to this ECR repo only.
  statement {
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.this.arn]
  }
  # Update this Lambda's image.
  statement {
    actions   = ["lambda:UpdateFunctionCode", "lambda:GetFunction"]
    resources = [aws_lambda_function.this.arn]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions.json
}

# --- Outputs ---
output "function_url" {
  value = aws_lambda_function_url.this.function_url
}

output "ecr_repo_url" {
  value = aws_ecr_repository.this.repository_url
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}

output "github_actions_role_arn" {
  value       = aws_iam_role.github_actions.arn
  description = "Put this in the repo's Actions settings as a secret or vars entry (see .github/workflows/deploy-single.yml)."
}

output "lambda_function_name" {
  value = aws_lambda_function.this.function_name
}

output "neon_connection_uri" {
  value     = neon_project.this.connection_uri
  sensitive = true
}
