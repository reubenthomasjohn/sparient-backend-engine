provider "aws" {
  region  = var.region
  profile = var.use_aws_profile ? var.aws_profile : null
}

provider "neon" {
  api_key = var.neon_api_key
}

data "aws_caller_identity" "current" {}

# --- Neon Postgres ---
resource "neon_project" "this" {
  name                      = var.name_prefix
  region_id                 = "aws-${var.region}"
  pg_version                = 16
  history_retention_seconds = 21600
}

# --- ECR ---
module "ecr" {
  source      = "../../modules/ecr"
  name_prefix = var.name_prefix
}

# --- Discovery queue (tick + institution fan-out) ---
module "queues" {
  source      = "../../modules/queues"
  name_prefix = var.name_prefix
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

# --- Responses SQS queue (S3 event → SQS → responses Lambda) ---
resource "aws_sqs_queue" "responses_dlq" {
  name                      = "${var.name_prefix}-responses-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "responses" {
  name                       = "${var.name_prefix}-responses"
  visibility_timeout_seconds = 900
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.responses_dlq.arn
    maxReceiveCount     = 3
  })
}

data "aws_iam_policy_document" "allow_s3_to_sqs" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.responses.arn]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.responses.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "allow_s3" {
  queue_url = aws_sqs_queue.responses.id
  policy    = data.aws_iam_policy_document.allow_s3_to_sqs.json
}

resource "aws_s3_bucket_notification" "responses" {
  bucket = aws_s3_bucket.responses.id
  queue {
    queue_arn     = aws_sqs_queue.responses.arn
    events        = ["s3:ObjectCreated:*"]
    filter_suffix = ".json"
  }
  depends_on = [aws_sqs_queue_policy.allow_s3]
}

# --- Shared Lambda execution role ---
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${var.name_prefix}-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda_runtime" {
  # SQS
  statement {
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = concat(module.queues.all_queue_arns, [aws_sqs_queue.responses.arn])
  }

  # S3
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

  # Step Functions — discovery Lambda needs to start executions
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.course_workflow.arn]
  }
}

resource "aws_iam_role_policy" "lambda_runtime" {
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_runtime.json
}

# --- Env vars shared by all Lambdas ---
locals {
  common_env = {
    NODE_ENV                            = "production"
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    DATABASE_URL                        = neon_project.this.connection_uri
    S3_SOURCE_BUCKET                    = var.s3_source_bucket
    S3_REMEDIATED_BUCKET                = var.s3_remediated_bucket
    SQS_DISCOVERY_URL                   = module.queues.discovery_queue_url
    QUEUE_START_CONSUMERS               = "false"
    S3_REQUESTS_BUCKET                  = aws_s3_bucket.requests.id
    S3_RESPONSES_BUCKET                 = aws_s3_bucket.responses.id
  }
}

# --- Lambdas ---

# Discovery: tick + institution fan-out (starts SFN executions)
module "discovery_worker" {
  source          = "../../modules/lambda-worker"
  name_prefix     = var.name_prefix
  worker_name     = "discovery"
  ecr_repo_url    = module.ecr.repo_urls["sparient-discovery"]
  queue_arn       = module.queues.discovery_queue_arn
  queue_url       = module.queues.discovery_queue_url
  dlq_arn         = module.queues.discovery_queue_arn
  max_concurrency = var.discovery_max_concurrency
  role_arn        = aws_iam_role.lambda_exec.arn
  env             = merge(local.common_env, {
    COURSE_WORKFLOW_ARN = aws_sfn_state_machine.course_workflow.arn
  })
}

# Course workflow: all 3 Step Functions steps (discover-files, upload-file, batch-publish)
resource "aws_cloudwatch_log_group" "course_workflow_lambda" {
  name              = "/aws/lambda/${var.name_prefix}-course-workflow"
  retention_in_days = 14
}

resource "aws_lambda_function" "course_workflow" {
  function_name = "${var.name_prefix}-course-workflow"
  role          = aws_iam_role.lambda_exec.arn
  package_type  = "Image"
  image_uri     = "${module.ecr.repo_urls["sparient-course-workflow"]}:bootstrap"
  architectures = ["x86_64"]
  timeout       = 900
  memory_size   = 1024

  environment {
    variables = local.common_env
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_cloudwatch_log_group.course_workflow_lambda]
}

# Responses: S3 event → SQS → Lambda
module "responses_worker" {
  source          = "../../modules/lambda-worker"
  name_prefix     = var.name_prefix
  worker_name     = "responses"
  ecr_repo_url    = module.ecr.repo_urls["sparient-responses"]
  queue_arn       = aws_sqs_queue.responses.arn
  queue_url       = aws_sqs_queue.responses.url
  dlq_arn         = aws_sqs_queue.responses_dlq.arn
  max_concurrency = 5
  role_arn        = aws_iam_role.lambda_exec.arn
  env             = local.common_env
}

# API
module "api" {
  source                  = "../../modules/lambda-api"
  name_prefix             = var.name_prefix
  ecr_repo_url            = module.ecr.repo_urls["sparient-api"]
  role_arn                = aws_iam_role.lambda_exec.arn
  provisioned_concurrency = var.api_provisioned_concurrency
  env                     = merge(local.common_env, {
    COURSE_WORKFLOW_ARN = aws_sfn_state_machine.course_workflow.arn
  })
}

# --- Step Functions: course workflow ---
# discover-files → Map(upload-file, max 10) → batch-publish
data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${var.name_prefix}-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn_runtime" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.course_workflow.arn]
  }
}

resource "aws_iam_role_policy" "sfn_runtime" {
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn_runtime.json
}

resource "aws_sfn_state_machine" "course_workflow" {
  name     = "${var.name_prefix}-course-workflow"
  role_arn = aws_iam_role.sfn.arn

  definition = jsonencode({
    Comment = "Per-course workflow: discover files → upload in parallel → batch + publish"
    StartAt = "DiscoverFiles"
    States = {
      DiscoverFiles = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.course_workflow.arn
          Payload = {
            "step"            = "discover-files"
            "institutionId.$" = "$.institutionId"
            "canvasCourseId.$" = "$.canvasCourseId"
            "force.$"         = "$.force"
          }
        }
        ResultPath = "$.discovery"
        ResultSelector = {
          "institutionId.$"   = "$.Payload.institutionId"
          "canvasCourseId.$"  = "$.Payload.canvasCourseId"
          "courseId.$"        = "$.Payload.courseId"
          "isInitialSync.$"   = "$.Payload.isInitialSync"
          "uploadJobs.$"      = "$.Payload.uploadJobs"
        }
        Next = "CheckUploads"
      }

      CheckUploads = {
        Type = "Choice"
        Choices = [{
          Variable        = "$.discovery.uploadJobs[0]"
          IsPresent       = true
          Next            = "UploadFiles"
        }]
        Default = "BatchAndPublish"
      }

      UploadFiles = {
        Type          = "Map"
        ItemsPath     = "$.discovery.uploadJobs"
        MaxConcurrency = 10
        ResultPath    = "$.uploadResults"
        // Inject institutionId from parent context into each Map item
        ItemSelector = {
          "sourceFileId.$"  = "$$.Map.Item.Value.sourceFileId"
          "modifiedAtMs.$"  = "$$.Map.Item.Value.modifiedAtMs"
          "institutionId.$" = "$.discovery.institutionId"
        }
        ItemProcessor = {
          ProcessorConfig = {
            Mode = "INLINE"
          }
          StartAt = "UploadOneFile"
          States = {
            UploadOneFile = {
              Type     = "Task"
              Resource = "arn:aws:states:::lambda:invoke"
              Parameters = {
                FunctionName = aws_lambda_function.course_workflow.arn
                Payload = {
                  "step"           = "upload-file"
                  "sourceFileId.$" = "$.sourceFileId"
                  "modifiedAtMs.$" = "$.modifiedAtMs"
                  "institutionId.$" = "$.institutionId"
                }
              }
              ResultSelector = {
                "sourceFileId.$" = "$.Payload.sourceFileId"
                "success.$"      = "$.Payload.success"
              }
              Retry = [{
                ErrorEquals     = ["States.ALL"]
                MaxAttempts     = 2
                IntervalSeconds = 30
                BackoffRate     = 2
              }]
              End = true
            }
          }
        }
        Next = "BatchAndPublish"
      }

      BatchAndPublish = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.course_workflow.arn
          Payload = {
            "step"             = "batch-publish"
            "institutionId.$"  = "$.discovery.institutionId"
            "canvasCourseId.$" = "$.discovery.canvasCourseId"
            "courseId.$"       = "$.discovery.courseId"
            "isInitialSync.$"  = "$.discovery.isInitialSync"
            "uploadResults.$"  = "$.uploadResults"
          }
        }
        ResultPath = "$.batchResult"
        End        = true
      }
    }
  })
}

# --- Tick schedule (every 15 min) ---
module "schedule" {
  source           = "../../modules/schedule"
  name_prefix      = var.name_prefix
  target_queue_arn = module.queues.discovery_queue_arn
  target_queue_url = module.queues.discovery_queue_url
}

# --- GitHub Actions OIDC ---
locals {
  github_repo_full = "${var.github_owner}/${var.github_repo_name}"
}

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
      values   = ["repo:${local.github_repo_full}:ref:refs/heads/${var.github_deploy_branch}"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${var.name_prefix}-github-actions"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

resource "aws_iam_role_policy_attachment" "github_admin" {
  role       = aws_iam_role.github_actions.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
