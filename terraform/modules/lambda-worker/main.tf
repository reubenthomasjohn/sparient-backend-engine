# Generic SQS-triggered Lambda. Used for discovery + upload.
# Image is referenced by digest (not :latest) so terraform apply is reproducible.

variable "name_prefix"        { type = string }
variable "worker_name"        { type = string } # "discovery" or "upload"
variable "ecr_repo_url"       { type = string } # ECR repo URL — Lambda starts with :bootstrap, CI updates
variable "queue_arn"          { type = string }
variable "queue_url"          { type = string }
variable "dlq_arn"            { type = string } # for permissions parity; unused at runtime
variable "max_concurrency"    { type = number } # caps SQS event source concurrency
variable "vpc_subnet_ids" {
  type    = list(string)
  default = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}
variable "env"                { type = map(string) }
variable "role_arn"           { type = string }

variable "timeout_seconds" {
  type    = number
  default = 900
}

variable "memory_mb" {
  type    = number
  default = 1024
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name_prefix}-${var.worker_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "this" {
  function_name = "${var.name_prefix}-${var.worker_name}"
  role          = var.role_arn
  package_type  = "Image"
  image_uri     = "${var.ecr_repo_url}:bootstrap"
  architectures = ["x86_64"]
  timeout       = var.timeout_seconds
  memory_size   = var.memory_mb

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.security_group_ids
    }
  }

  environment {
    variables = var.env
  }

  lifecycle {
    ignore_changes = [image_uri] # CI owns image rollouts
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

resource "aws_lambda_event_source_mapping" "sqs" {
  event_source_arn                   = var.queue_arn
  function_name                      = aws_lambda_function.this.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  scaling_config {
    maximum_concurrency = var.max_concurrency
  }
  function_response_types = ["ReportBatchItemFailures"]
}

output "function_name" { value = aws_lambda_function.this.function_name }
output "function_arn"  { value = aws_lambda_function.this.arn }
