# Two queues, two DLQs. Visibility timeout = 15 min so a slow upload doesn't get redelivered
# while still running. Messages that fail maxReceiveCount times land in the DLQ and stay
# there until an operator inspects them — there's no automatic retry off the DLQ.

variable "name_prefix" { type = string }

variable "visibility_timeout_seconds" {
  type    = number
  default = 900 # 15 min — must be >= Lambda timeout
}

variable "max_receive_count" {
  type    = number
  default = 3
}

locals {
  queue_names = ["discovery", "upload"]
}

resource "aws_sqs_queue" "dlq" {
  for_each                  = toset(local.queue_names)
  name                      = "${var.name_prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14d max
}

resource "aws_sqs_queue" "main" {
  for_each                   = toset(local.queue_names)
  name                       = "${var.name_prefix}-${each.key}"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })
}

output "discovery_queue_url" { value = aws_sqs_queue.main["discovery"].url }
output "upload_queue_url"    { value = aws_sqs_queue.main["upload"].url }
output "discovery_queue_arn" { value = aws_sqs_queue.main["discovery"].arn }
output "upload_queue_arn"    { value = aws_sqs_queue.main["upload"].arn }
output "all_queue_arns"      { value = [for q in aws_sqs_queue.main : q.arn] }
