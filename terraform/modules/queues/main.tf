# SQS queues with DLQs. Discovery: upload fan-out is handled by Step Functions, not SQS.
# Writeback: one message per writeback-eligible batch_file, fan-out from RemediationService.

variable "name_prefix" { type = string }

variable "visibility_timeout_seconds" {
  type    = number
  default = 900
}

variable "max_receive_count" {
  type    = number
  default = 3
}

resource "aws_sqs_queue" "discovery_dlq" {
  name                      = "${var.name_prefix}-discovery-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "discovery" {
  name                       = "${var.name_prefix}-discovery"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.discovery_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue" "writeback_dlq" {
  name                      = "${var.name_prefix}-writeback-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "writeback" {
  name                       = "${var.name_prefix}-writeback"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.writeback_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

output "discovery_queue_url" { value = aws_sqs_queue.discovery.url }
output "discovery_queue_arn" { value = aws_sqs_queue.discovery.arn }
output "writeback_queue_url" { value = aws_sqs_queue.writeback.url }
output "writeback_queue_arn" { value = aws_sqs_queue.writeback.arn }
output "writeback_dlq_arn" { value = aws_sqs_queue.writeback_dlq.arn }
output "all_queue_arns" { value = [aws_sqs_queue.discovery.arn, aws_sqs_queue.writeback.arn] }
