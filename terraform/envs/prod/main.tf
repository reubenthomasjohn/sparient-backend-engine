provider "aws" {
  region  = var.region
  profile = var.use_aws_profile ? var.aws_profile : null
}

data "aws_caller_identity" "current" {}

# --- Networking: VPC + single NAT + public/private subnets ---
module "networking" {
  source      = "../../modules/networking"
  name_prefix = var.name_prefix
  azs         = var.azs
}

# Shared SG for all VPC Lambdas. Egress to the NAT (Canvas + AWS APIs); the database
# module adds the ingress rule that lets this SG reach the RDS Proxy on 5432.
resource "aws_security_group" "lambda" {
  name        = "${var.name_prefix}-lambda-sg"
  description = "Shared SG for VPC Lambdas - egress to NAT, ingress allowed to RDS Proxy"
  vpc_id      = module.networking.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "lambda_all" {
  security_group_id = aws_security_group.lambda.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- RDS Postgres + RDS Proxy (connection pooling) ---
module "database" {
  source       = "../../modules/database"
  name_prefix  = var.name_prefix
  vpc_id       = module.networking.vpc_id
  subnet_ids   = module.networking.private_subnet_ids
  lambda_sg_id = aws_security_group.lambda.id

  instance_class          = var.db_instance_class
  backup_retention_period = var.db_backup_retention_period
  deletion_protection     = true  # prod safety: block accidental `terraform destroy`
  skip_final_snapshot     = false # take a final snapshot if the DB is ever destroyed
  multi_az                = false # safe single-AZ
}

# --- ECR (5 app repos; the migrate repo is created standalone below) ---
module "ecr" {
  source      = "../../modules/ecr"
  name_prefix = var.name_prefix
}

# --- Discovery queue (tick + institution fan-out) ---
module "queues" {
  source      = "../../modules/queues"
  name_prefix = var.name_prefix
}

# S3 buckets are per-institution, created dynamically by InstitutionBucketService.
# No Terraform-managed bucket resource — Lambdas have IAM access to sparient-* buckets.

# --- Explainer-video bucket ---
# accesshub-videos is an account-level shared asset managed by terraform/bootstrap (not by
# any env), so prod just references it by literal ARN in IAM below. Tearing down either env
# leaves the bucket untouched.

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

# S3 → SQS policy: allow ANY sparient-* bucket to send notifications to the responses queue.
data "aws_iam_policy_document" "allow_s3_to_sqs" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.responses.arn]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:s3:::sparient-*", "arn:aws:s3:::accesshub-*"]
    }
  }
}

resource "aws_sqs_queue_policy" "allow_s3" {
  queue_url = aws_sqs_queue.responses.id
  policy    = data.aws_iam_policy_document.allow_s3_to_sqs.json
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

# VPC Lambdas need ENI create/delete permissions.
resource "aws_iam_role_policy_attachment" "vpc_access" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
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
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      "arn:aws:s3:::sparient-*/*",
      "arn:aws:s3:::accesshub-remediation-storage/*",
      "arn:aws:s3:::accesshub-videos/*",
    ]
  }
  statement {
    actions = ["s3:ListBucket"]
    resources = [
      "arn:aws:s3:::sparient-*",
      "arn:aws:s3:::accesshub-remediation-storage",
      "arn:aws:s3:::accesshub-videos",
    ]
  }
  statement {
    actions   = ["s3:CreateBucket", "s3:PutBucketNotification", "s3:PutBucketPublicAccessBlock"]
    resources = ["arn:aws:s3:::sparient-*"]
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
  # The app connects to the RDS Proxy (not RDS directly) using the proxy's secret-backed
  # credentials. verify-full + the bundled Amazon RDS CA (NODE_EXTRA_CA_CERTS) verify the
  # proxy's TLS cert. Password chars are URL-safe (override_special = "_-"), so no encoding.
  database_url = "postgresql://${module.database.db_username}:${module.database.db_password}@${module.database.proxy_endpoint}:5432/${module.database.db_name}?sslmode=verify-full"

  common_env = {
    NODE_ENV                            = "production"
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    DATABASE_URL                        = local.database_url
    NODE_EXTRA_CA_CERTS                 = "/var/task/certs/rds-global-bundle.pem"
    SQS_DISCOVERY_URL                   = module.queues.discovery_queue_url
    SQS_WRITEBACK_URL                   = module.queues.writeback_queue_url
    SQS_RESPONSES_QUEUE_ARN             = aws_sqs_queue.responses.arn
    QUEUE_START_CONSUMERS               = "false"
    # Per-institution bucket prefix: <prefix>-<slug>. Includes the stage so prod and
    # dev never collide on a shared slug in this shared account. Must start "sparient-".
    INSTITUTION_BUCKET_PREFIX           = "${var.name_prefix}-accesshub"
  }

  lambda_vpc_subnets = module.networking.private_subnet_ids
  lambda_sg_ids      = [aws_security_group.lambda.id]
}

# --- Lambdas ---

# Discovery: tick + institution fan-out (starts SFN executions)
module "discovery_worker" {
  source             = "../../modules/lambda-worker"
  name_prefix        = var.name_prefix
  worker_name        = "discovery"
  ecr_repo_url       = module.ecr.repo_urls["sparient-discovery"]
  queue_arn          = module.queues.discovery_queue_arn
  queue_url          = module.queues.discovery_queue_url
  dlq_arn            = module.queues.discovery_queue_arn
  max_concurrency    = var.discovery_max_concurrency
  role_arn           = aws_iam_role.lambda_exec.arn
  vpc_subnet_ids     = local.lambda_vpc_subnets
  security_group_ids = local.lambda_sg_ids
  env = merge(local.common_env, {
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

  vpc_config {
    subnet_ids         = local.lambda_vpc_subnets
    security_group_ids = local.lambda_sg_ids
  }

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
  source             = "../../modules/lambda-worker"
  name_prefix        = var.name_prefix
  worker_name        = "responses"
  ecr_repo_url       = module.ecr.repo_urls["sparient-responses"]
  queue_arn          = aws_sqs_queue.responses.arn
  queue_url          = aws_sqs_queue.responses.url
  dlq_arn            = aws_sqs_queue.responses_dlq.arn
  max_concurrency    = 5
  role_arn           = aws_iam_role.lambda_exec.arn
  vpc_subnet_ids     = local.lambda_vpc_subnets
  security_group_ids = local.lambda_sg_ids
  env                = local.common_env
}

# Writeback: RemediationService → SQS → Lambda → Canvas. Concurrency capped low to
# respect Canvas's rate limits. Timeout 150s keeps the AWS-recommended ≥ 6× ratio to
# the queue's 900s visibility timeout.
module "writeback_worker" {
  source             = "../../modules/lambda-worker"
  name_prefix        = var.name_prefix
  worker_name        = "writeback"
  ecr_repo_url       = module.ecr.repo_urls["sparient-writeback"]
  queue_arn          = module.queues.writeback_queue_arn
  queue_url          = module.queues.writeback_queue_url
  dlq_arn            = module.queues.writeback_dlq_arn
  max_concurrency    = var.writeback_max_concurrency
  timeout_seconds    = 150
  role_arn           = aws_iam_role.lambda_exec.arn
  vpc_subnet_ids     = local.lambda_vpc_subnets
  security_group_ids = local.lambda_sg_ids
  env                = local.common_env
}

# API
module "api" {
  source                  = "../../modules/lambda-api"
  name_prefix             = var.name_prefix
  ecr_repo_url            = module.ecr.repo_urls["sparient-api"]
  role_arn                = aws_iam_role.lambda_exec.arn
  provisioned_concurrency = var.api_provisioned_concurrency
  vpc_subnet_ids          = local.lambda_vpc_subnets
  security_group_ids      = local.lambda_sg_ids
  env = merge(local.common_env, {
    COURSE_WORKFLOW_ARN = aws_sfn_state_machine.course_workflow.arn
  })
}

# --- Migration runner ---
# Standalone ECR repo + Lambda (image built from Dockerfile.migrate). No event source —
# CI invokes it after `terraform apply` to run `prisma migrate deploy` inside the VPC,
# where the private RDS Proxy is reachable.
resource "aws_ecr_repository" "migrate" {
  name                 = "${var.name_prefix}-migrate"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/aws/lambda/${var.name_prefix}-migrate"
  retention_in_days = 14
}

resource "aws_lambda_function" "migrate" {
  function_name = "${var.name_prefix}-migrate"
  role          = aws_iam_role.lambda_exec.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.migrate.repository_url}:bootstrap"
  architectures = ["x86_64"]
  timeout       = 300
  memory_size   = 1024

  vpc_config {
    subnet_ids         = local.lambda_vpc_subnets
    security_group_ids = local.lambda_sg_ids
  }

  environment {
    variables = local.common_env
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_cloudwatch_log_group.migrate]
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
            "step"             = "discover-courses"
            "institutionId.$"  = "$.institutionId"
            "force.$"          = "$.force"
            "singleCourseId.$" = "$.singleCourseId"
          }
        }
        ResultSelector = {
          "institutionId.$" = "$.Payload.institutionId"
          "s3Bucket.$"      = "$.Payload.s3Bucket"
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
          "s3Bucket.$"       = "$.context.s3Bucket"
          "force.$"          = "$.context.force"
          "canvasCourseId.$" = "$$.Map.Item.Value.canvasCourseId"
          "courseId.$"       = "$$.Map.Item.Value.courseId"
        }
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt         = "DiscoverFiles"
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
                  "s3Bucket.$"       = "$.s3Bucket"
                  "canvasCourseId.$" = "$.canvasCourseId"
                  "courseId.$"       = "$.courseId"
                  "force.$"          = "$.force"
                }
              }
              ResultPath = "$.discovery"
              ResultSelector = {
                "hasWork.$"       = "$.Payload.hasWork"
                "isInitialSync.$" = "$.Payload.isInitialSync"
                "fileIds.$"       = "$.Payload.fileIds"
                "s3Bucket.$"      = "$.Payload.s3Bucket"
              }
              Next = "CheckHasWork"
            }

            # Skip courses with no work (no uploads, no retries, no stuck batches).
            CheckHasWork = {
              Type = "Choice"
              Choices = [{
                Variable      = "$.discovery.hasWork"
                BooleanEquals = true
                Next          = "UploadFiles"
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
                "s3Bucket.$"     = "$.discovery.s3Bucket"
              }
              ItemProcessor = {
                ProcessorConfig = { Mode = "INLINE" }
                StartAt         = "UploadOneFile"
                States = {
                  UploadOneFile = {
                    Type     = "Task"
                    Resource = "arn:aws:states:::lambda:invoke"
                    Parameters = {
                      FunctionName = aws_lambda_function.course_workflow.arn
                      Payload = {
                        "step"           = "upload-file"
                        "sourceFileId.$" = "$.sourceFileId"
                        "s3Bucket.$"     = "$.s3Bucket"
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
                  "s3Bucket.$"       = "$.s3Bucket"
                  "canvasCourseId.$" = "$.canvasCourseId"
                  "courseId.$"       = "$.courseId"
                  "isInitialSync.$"  = "$.discovery.isInitialSync"
                  "force.$"          = "$.force"
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
