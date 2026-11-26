variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "aws_region" {
  type        = string
  description = "AWS region for ECS logs and SDK configuration"
  default     = "us-east-1"
}

variable "vpc_id" {
  type        = string
  description = "VPC ID where ALB and ECS tasks run"
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Public subnet IDs for the Application Load Balancer"
}

variable "private_app_subnet_ids" {
  type        = list(string)
  description = "Private application subnet IDs for ECS Fargate tasks"
}

variable "alb_sg_id" {
  type        = string
  description = "Security group ID attached to the ALB"
}

variable "api_sg_id" {
  type        = string
  description = "Security group ID attached to API ECS tasks"
}

variable "worker_sg_id" {
  type        = string
  description = "Security group ID attached to worker and init ECS tasks"
}

variable "alb_acm_certificate_arn" {
  type        = string
  description = "Optional ACM certificate ARN for HTTPS listener on ALB; null uses HTTP behind CloudFront + X-Origin-Verify"
  default     = null
}

variable "deletion_protection" {
  type        = bool
  description = "Enable deletion protection on the Application Load Balancer"
  default     = true
}

variable "origin_verify_secret" {
  type        = string
  sensitive   = true
  description = "Generated secret shared between CloudFront custom header and ALB listener rule (Change #1 & #6)"
}

variable "media_bucket_name" {
  type        = string
  description = "Private media S3 bucket name"
}

variable "media_bucket_arn" {
  type        = string
  description = "Private media S3 bucket ARN"
}

variable "media_cloudfront_domain" {
  type        = string
  description = "Media CloudFront domain name for MEDIA_PUBLIC_BASE_URL"
}

variable "client_cloudfront_domain" {
  type        = string
  description = "Client CloudFront domain name for CORS_ORIGINS"
}

variable "queue_urls" {
  type        = map(string)
  description = "Map of queue role name -> SQS queue URL"
}

variable "queue_names" {
  type        = map(string)
  description = "Map of queue role name -> SQS queue physical name"
}

variable "queue_arns" {
  type        = map(string)
  description = "Map of queue role name -> SQS queue ARN"
}

variable "dlq_arns" {
  type        = map(string)
  description = "Map of queue role name -> SQS DLQ ARN"
}

variable "opensearch_endpoint" {
  type        = string
  description = "OpenSearch HTTPS endpoint, or empty string when disabled"
  default     = ""
}

variable "opensearch_domain_arn" {
  type        = string
  description = "OpenSearch domain ARN, or null when disabled"
  default     = null
}

variable "enable_opensearch" {
  type        = bool
  description = "Whether OpenSearch indexing/searching is enabled"
  default     = false
}

variable "enable_mock_payment_provider" {
  type        = bool
  description = "Run optional test-mode mock payment provider ECS service in private Cloud Map namespace"
  default     = false
}

variable "server_image_tag" {
  type        = string
  description = "Container image tag deployed to ECS from nestly-server ECR repository"
  default     = "initial"
}

variable "api_desired_count" {
  type        = number
  description = "Desired ECS task count for API service (multi-AZ HA)"
  default     = 2
}

variable "worker_consumer_desired_count" {
  type        = number
  description = "Desired ECS task count for SQS consumer workers"
  default     = 1
}

variable "api_cpu" {
  type        = number
  description = "Fargate CPU units for API tasks"
  default     = 512
}

variable "api_memory" {
  type        = number
  description = "Fargate memory (MiB) for API tasks"
  default     = 1024
}

variable "worker_cpu" {
  type        = number
  description = "Fargate CPU units for worker tasks"
  default     = 256
}

variable "worker_memory" {
  type        = number
  description = "Fargate memory (MiB) for worker tasks"
  default     = 512
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log group retention days"
  default     = 30
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
