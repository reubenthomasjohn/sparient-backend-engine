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

# --- S3 bucket (single bucket, 4 prefixes) ---
# Bucket already exists (created manually). Import into state if needed:
#   terraform import aws_s3_bucket.main sparient-remediation-testing
resource "aws_s3_bucket" "main" {
  bucket = var.s3_bucket
}

resource "aws_s3_bucket_public_access_block" "main" {
  bucket                  = aws_s3_bucket.main.id
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
      values   = [aws_s3_bucket.main.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "allow_s3" {
  queue_url = aws_sqs_queue.responses.id
  policy    = data.aws_iam_policy_document.allow_s3_to_sqs.json
}

resource "aws_s3_bucket_notification" "responses" {
  bucket = aws_s3_bucket.main.id
  queue {
    queue_arn     = aws_sqs_queue.responses.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "sparient-remediation-responses/"
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
    resources = ["${aws_s3_bucket.main.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.main.arn]
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
    S3_BUCKET                           = aws_s3_bucket.main.id
    SQS_DISCOVERY_URL                   = module.queues.discovery_queue_url
    QUEUE_START_CONSUMERS               = "false"
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

# --- Step Functions: institution workflow ---
# One execution per institution. Nested Maps:
#   discover-courses → Map(courses) → discover-files → Choice → Map(uploads) → batch-publish
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
    Comment = "Per-institution workflow: discover courses → Map(per course: discover files → upload → batch)"
    StartAt = "DiscoverCourses"
    States = {

      # Step 0: List courses from Canvas, upsert to DB, return course list.
      DiscoverCourses = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.course_workflow.arn
          Payload = {
            "step"            = "discover-courses"
            "institutionId.$" = "$.institutionId"
            "force.$"         = "$.force"
            "singleCourseId.$" = "$.singleCourseId"
          }
        }
        ResultSelector = {
          "institutionId.$" = "$.Payload.institutionId"
          "force.$"         = "$.Payload.force"
          "courses.$"       = "$.Payload.courses"
        }
        ResultPath = "$.context"
        Next       = "ProcessCourses"
      }

      # Outer Map: one iteration per course, bounded concurrency.
      ProcessCourses = {
        Type           = "Map"
        ItemsPath      = "$.context.courses"
        MaxConcurrency = 3
        ResultPath     = "$.courseResults"
        ItemSelector = {
          "institutionId.$"  = "$.context.institutionId"
          "force.$"          = "$.context.force"
          "canvasCourseId.$" = "$$.Map.Item.Value.canvasCourseId"
          "courseId.$"        = "$$.Map.Item.Value.courseId"
        }
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt = "DiscoverFiles"
          States = {

            # Step 1: Discover files for this course.
            DiscoverFiles = {
              Type     = "Task"
              Resource = "arn:aws:states:::lambda:invoke"
              Parameters = {
                FunctionName = aws_lambda_function.course_workflow.arn
                Payload = {
                  "step"             = "discover-files"
                  "institutionId.$"  = "$.institutionId"
                  "canvasCourseId.$" = "$.canvasCourseId"
                  "courseId.$"       = "$.courseId"
                  "force.$"         = "$.force"
                }
              }
              ResultPath = "$.discovery"
              ResultSelector = {
                "hasWork.$"        = "$.Payload.hasWork"
                "isInitialSync.$"  = "$.Payload.isInitialSync"
                "fileIds.$"        = "$.Payload.fileIds"
              }
              Next = "CheckHasWork"
            }

            # Skip courses with no work (no uploads, no retries, no stuck batches).
            CheckHasWork = {
              Type = "Choice"
              Choices = [{
                Variable  = "$.discovery.hasWork"
                BooleanEquals = true
                Next      = "UploadFiles"
              }]
              Default = "SkipCourse"
            }

            SkipCourse = {
              Type = "Pass"
              End  = true
            }

            # Step 2: Upload changed files in parallel.
            UploadFiles = {
              Type           = "Map"
              ItemsPath      = "$.discovery.fileIds"
              MaxConcurrency = 3
              ResultPath     = "$.uploadResults"
              ItemSelector = {
                "sourceFileId.$" = "$$.Map.Item.Value"
              }
              ItemProcessor = {
                ProcessorConfig = { Mode = "INLINE" }
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
                    Catch = [{
                      ErrorEquals = ["States.ALL"]
                      ResultPath  = "$.error"
                      Next        = "UploadFailed"
                    }]
                    End = true
                  }
                  UploadFailed = {
                    Type   = "Pass"
                    Result = { success = false }
                    End    = true
                  }
                }
              }
              Next = "BatchAndPublish"
            }

            # Step 3: Batch + publish (reads eligible files from DB).
            BatchAndPublish = {
              Type     = "Task"
              Resource = "arn:aws:states:::lambda:invoke"
              Parameters = {
                FunctionName = aws_lambda_function.course_workflow.arn
                Payload = {
                  "step"             = "batch-publish"
                  "institutionId.$"  = "$.institutionId"
                  "canvasCourseId.$" = "$.canvasCourseId"
                  "courseId.$"       = "$.courseId"
                  "isInitialSync.$"  = "$.discovery.isInitialSync"
                }
              }
              ResultPath = "$.batchResult"
              Catch = [{
                ErrorEquals = ["States.ALL"]
                ResultPath  = "$.batchError"
                Next        = "BatchFailed"
              }]
              End = true
            }

            BatchFailed = {
              Type = "Pass"
              End  = true
            }
          }
        }
        End = true
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
