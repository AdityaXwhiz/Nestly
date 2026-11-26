variable "project_name" {
  type        = string
  description = "Project identifier"
  default     = "nestly"
}

variable "environment" {
  type        = string
  description = "Deployment environment name"
  default     = "dev"
}

variable "aws_region" {
  type        = string
  description = "Target AWS region"
  default     = "us-east-1"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID (explicit variable; set via terraform.tfvars before apply)"
  default     = "123456789012"
}

variable "azs" {
  type        = list(string)
  description = "Availability zones for multi-AZ VPC layout"
  default     = ["us-east-1a", "us-east-1b"]
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR block"
  default     = "10.20.0.0/16"
}

variable "single_nat_gateway" {
  type        = bool
  description = "Use single NAT gateway in dev to reduce baseline hourly cost"
  default     = true
}

variable "enable_interface_endpoints" {
  type        = bool
  description = "Provision VPC Interface Endpoints for SQS, Secrets Manager, ECR, and Logs"
  default     = true
}

variable "cloudfront_prefix_list_id" {
  type        = string
  description = "AWS CloudFront origin-facing managed prefix list ID (us-east-1 default)"
  default     = "pl-3b927c52"
}

variable "pg_instance_class" {
  type        = string
  description = "RDS PostgreSQL instance size"
  default     = "db.t4g.micro"
}

variable "rds_multi_az" {
  type        = bool
  description = "Enable RDS Multi-AZ standby (true recommended for production)"
  default     = false
}

variable "deletion_protection" {
  type        = bool
  description = "Protect stateful RDS and ALB from accidental deletion"
  default     = true
}

variable "backup_retention_period" {
  type        = number
  description = "RDS automated PITR backup retention days"
  default     = 7
}

variable "skip_final_snapshot" {
  type        = bool
  description = "Skip final RDS snapshot on destroy (false recommended)"
  default     = false
}

variable "redis_node_type" {
  type        = string
  description = "ElastiCache Redis node size"
  default     = "cache.t4g.micro"
}

variable "redis_num_nodes" {
  type        = number
  description = "ElastiCache Redis node count (>= 2 for Multi-AZ failover)"
  default     = 1
}

variable "enable_opensearch" {
  type        = bool
  description = "Provision managed Amazon OpenSearch domain (false uses PostgreSQL full-text fallback)"
  default     = false
}

variable "enable_waf" {
  type        = bool
  description = "Attach optional AWS WAFv2 WebACL to client CloudFront distribution"
  default     = false
}

variable "enable_mock_payment_provider" {
  type        = bool
  description = "Deploy test-mode mock payment provider inside private ECS namespace"
  default     = false
}

variable "alb_acm_certificate_arn" {
  type        = string
  description = "Optional ACM certificate ARN for ALB HTTPS listener"
  default     = null
}

variable "api_desired_count" {
  type        = number
  description = "Desired API ECS Fargate tasks"
  default     = 2
}

variable "worker_consumer_desired_count" {
  type        = number
  description = "Desired SQS consumer worker ECS Fargate tasks"
  default     = 1
}

variable "server_image_tag" {
  type        = string
  description = "Initial server container image tag deployed from ECR"
  default     = "initial"
}

variable "alert_email" {
  type        = string
  description = "Optional alert notification email for CloudWatch alarms SNS topic"
  default     = null
}

variable "github_repo" {
  type        = string
  description = "GitHub repository owner/name permitted via OIDC"
  default     = "AdityaXwhiz/Nestly"
}

variable "github_environment" {
  type        = string
  description = "GitHub protected environment permitted via OIDC"
  default     = "production"
}
