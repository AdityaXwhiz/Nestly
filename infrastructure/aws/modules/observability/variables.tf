variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "alert_email" {
  type        = string
  description = "Optional email address subscribed to CloudWatch alert SNS notifications"
  default     = null
}

variable "queue_names" {
  type        = map(string)
  description = "Map of queue role name -> physical SQS primary queue name"
}

variable "dlq_names" {
  type        = map(string)
  description = "Map of queue role name -> physical SQS DLQ name"
}

variable "alb_arn_suffix" {
  type        = string
  description = "ALB ARN suffix for CloudWatch AWS/ApplicationELB alarms"
}

variable "rds_identifier" {
  type        = string
  description = "RDS DB instance identifier"
}

variable "redis_replication_group_id" {
  type        = string
  description = "ElastiCache Redis replication group ID"
}

variable "ecs_cluster_name" {
  type        = string
  description = "ECS cluster name"
}

variable "api_service_name" {
  type        = string
  description = "ECS API service name"
}

variable "worker_consumer_service_name" {
  type        = string
  description = "ECS worker consumer service name"
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
