variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "aws_region" {
  type        = string
  description = "AWS region"
  default     = "us-east-1"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID (explicit variable; avoids aws_caller_identity data source)"
  default     = "123456789012"
}

variable "github_repo" {
  type        = string
  description = "GitHub repository owner/name permitted to assume the OIDC deploy role"
  default     = "AdityaXwhiz/Nestly"
}

variable "github_environment" {
  type        = string
  description = "GitHub protected Environment required in OIDC sub claim (Change #10)"
  default     = "production"
}

variable "ecr_server_repository_arn" {
  type        = string
  description = "ECR ARN for nestly-server"
}

variable "client_bucket_arn" {
  type        = string
  description = "Private client SPA S3 bucket ARN"
}

variable "client_cloudfront_arn" {
  type        = string
  description = "Client + /api/* CloudFront distribution ARN"
}

variable "ecs_cluster_name" {
  type        = string
  description = "ECS cluster name"
}

variable "ecs_cluster_arn" {
  type        = string
  description = "ECS cluster ARN"
}

variable "ecs_service_names" {
  type        = list(string)
  description = "List of ECS service names updatable by CI deploy"
}

variable "init_task_definition_family" {
  type        = string
  description = "Family name of the one-off init ECS task definition"
}

variable "pass_role_arns" {
  type        = list(string)
  description = "Exact ECS execution and task role ARNs the deploy role may pass to ecs-tasks"
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
