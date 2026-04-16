# EventBridge rule → SQS target. Fires once a day and drops a {"type":"sweep"} message
# on the discovery queue. The discovery Lambda handles both sweep and per-institution
# discover messages.

variable "name_prefix"      { type = string }
variable "target_queue_arn" { type = string }
variable "target_queue_url" { type = string }

variable "schedule" {
  type    = string
  default = "rate(15 minutes)"
}

resource "aws_cloudwatch_event_rule" "tick" {
  name                = "${var.name_prefix}-tick"
  schedule_expression = var.schedule
}

# EventBridge needs permission to send to the SQS queue — attach a resource policy to the queue.
data "aws_iam_policy_document" "allow_events_to_sqs" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [var.target_queue_arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.tick.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "allow_events" {
  queue_url = var.target_queue_url
  policy    = data.aws_iam_policy_document.allow_events_to_sqs.json
}

resource "aws_cloudwatch_event_target" "sqs" {
  rule      = aws_cloudwatch_event_rule.tick.name
  target_id = "discovery-queue"
  arn       = var.target_queue_arn
  input     = jsonencode({ type = "tick" })
}
