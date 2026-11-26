output "alerts_sns_topic_arn" {
  value       = aws_sns_topic.alerts.arn
  description = "SNS topic ARN receiving CloudWatch operational alarms"
}

output "dlq_alarm_names" {
  value       = [for a in aws_cloudwatch_metric_alarm.dlq_non_empty : a.alarm_name]
  description = "CloudWatch alarm names monitoring all four SQS DLQs"
}
