locals {
  queue_set = toset(var.queue_names)

  # Enforce TLS in transit for every queue and DLQ via jsonencode policies (Change #5)
  main_queue_policy_docs = {
    for q in local.queue_set : q => jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Sid       = "DenyInsecureTransport"
          Effect    = "Deny"
          Principal = "*"
          Action    = "sqs:*"
          Resource  = aws_sqs_queue.main[q].arn
          Condition = {
            Bool = {
              "aws:SecureTransport" = "false"
            }
          }
        }
      ]
    })
  }

  dlq_policy_docs = {
    for q in local.queue_set : q => jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Sid       = "DenyInsecureTransport"
          Effect    = "Deny"
          Principal = "*"
          Action    = "sqs:*"
          Resource  = aws_sqs_queue.dlq[q].arn
          Condition = {
            Bool = {
              "aws:SecureTransport" = "false"
            }
          }
        }
      ]
    })
  }
}

resource "aws_sqs_queue" "dlq" {
  for_each = local.queue_set

  name                      = "${var.name_prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days for investigation and redrive
  sqs_managed_sse_enabled   = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-${each.key}-dlq"
    Role = "dlq"
  })
}

resource "aws_sqs_queue" "main" {
  for_each = local.queue_set

  name                       = "${var.name_prefix}-${each.key}"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 20     # Long polling
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-${each.key}"
    Role = "primary"
  })
}

resource "aws_sqs_queue_policy" "main" {
  for_each  = local.queue_set
  queue_url = aws_sqs_queue.main[each.key].id
  policy    = local.main_queue_policy_docs[each.key]
}

resource "aws_sqs_queue_policy" "dlq" {
  for_each  = local.queue_set
  queue_url = aws_sqs_queue.dlq[each.key].id
  policy    = local.dlq_policy_docs[each.key]
}
