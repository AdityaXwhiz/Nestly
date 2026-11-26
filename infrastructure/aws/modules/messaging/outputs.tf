output "queue_urls" {
  value       = { for k, q in aws_sqs_queue.main : k => q.url }
  description = "Map of queue role name to primary SQS queue URL"
}

output "queue_arns" {
  value       = { for k, q in aws_sqs_queue.main : k => q.arn }
  description = "Map of queue role name to primary SQS queue ARN"
}

output "queue_names" {
  value       = { for k, q in aws_sqs_queue.main : k => q.name }
  description = "Map of queue role name to primary SQS queue physical name"
}

output "dlq_urls" {
  value       = { for k, q in aws_sqs_queue.dlq : k => q.url }
  description = "Map of queue role name to DLQ URL"
}

output "dlq_arns" {
  value       = { for k, q in aws_sqs_queue.dlq : k => q.arn }
  description = "Map of queue role name to DLQ ARN"
}

output "dlq_names" {
  value       = { for k, q in aws_sqs_queue.dlq : k => q.name }
  description = "Map of queue role name to DLQ physical name"
}

output "queue_policy_documents" {
  value       = local.main_queue_policy_docs
  description = "SQS TLS-only queue policies exposed for inspection"
}

output "redrive_audit" {
  value = {
    main_queue_count = length(aws_sqs_queue.main)
    dlq_count        = length(aws_sqs_queue.dlq)
    queues = {
      for k, q in aws_sqs_queue.main : k => {
        max_receive_count = jsondecode(q.redrive_policy).maxReceiveCount
        sse_enabled       = q.sqs_managed_sse_enabled
      }
    }
  }
  description = "SQS queue & DLQ redrive attributes for terraform test assertions"
}
