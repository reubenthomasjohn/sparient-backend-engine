# API Lambda + API Gateway HTTP API (cheaper and simpler than REST API).
# 1 unit of provisioned concurrency keeps one instance warm — Connectivo polls land warm.

variable "name_prefix"        { type = string }
variable "ecr_repo_url"       { type = string }
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
  default = 30 # API GW HTTP API limit is 30s
}

variable "memory_mb" {
  type    = number
  default = 1024
}

variable "provisioned_concurrency" {
  type    = number
  default = 1 # 0 to disable
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name_prefix}-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "this" {
  function_name = "${var.name_prefix}-api"
  role          = var.role_arn
  package_type  = "Image"
  image_uri     = "${var.ecr_repo_url}:bootstrap"
  architectures = ["x86_64"]
  timeout       = var.timeout_seconds
  memory_size   = var.memory_mb
  publish       = var.provisioned_concurrency > 0 # versions are required for provisioned concurrency

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

resource "aws_lambda_alias" "live" {
  count            = var.provisioned_concurrency > 0 ? 1 : 0
  name             = "live"
  function_name    = aws_lambda_function.this.function_name
  function_version = aws_lambda_function.this.version
}

resource "aws_lambda_provisioned_concurrency_config" "this" {
  count                             = var.provisioned_concurrency > 0 ? 1 : 0
  function_name                     = aws_lambda_function.this.function_name
  qualifier                         = aws_lambda_alias.live[0].name
  provisioned_concurrent_executions = var.provisioned_concurrency
}

# --- API Gateway HTTP API ---
resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  payload_format_version = "2.0"
  integration_uri = var.provisioned_concurrency > 0 ? aws_lambda_alias.live[0].invoke_arn : aws_lambda_function.this.invoke_arn
}

resource "aws_apigatewayv2_route" "any" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "root" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "ANY /"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_gw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  qualifier     = var.provisioned_concurrency > 0 ? aws_lambda_alias.live[0].name : null
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

output "api_endpoint"  { value = aws_apigatewayv2_api.this.api_endpoint }
output "function_name" { value = aws_lambda_function.this.function_name }
output "function_arn"  { value = aws_lambda_function.this.arn }
