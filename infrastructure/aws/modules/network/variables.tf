variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "aws_region" {
  type        = string
  description = "AWS region for VPC endpoints (explicit variable to avoid AWS-calling data sources)"
  default     = "us-east-1"
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the Nestly VPC"
  default     = "10.20.0.0/16"
}

variable "azs" {
  type        = list(string)
  description = "Explicit Availability Zones for multi-AZ subnets (passed as variable; avoids AWS-calling data sources)"

  validation {
    condition     = length(var.azs) >= 2
    error_message = "At least two Availability Zones are required."
  }
}

variable "single_nat_gateway" {
  type        = bool
  description = "Use one NAT Gateway for all private app subnets (cost-saving dev default); set false for per-AZ HA"
  default     = true
}

variable "enable_interface_endpoints" {
  type        = bool
  description = "Create VPC Interface Endpoints for SQS, Secrets Manager, ECR, and CloudWatch Logs"
  default     = true
}

variable "app_port" {
  type        = number
  description = "Container port exposed by the Express API"
  default     = 3000
}

variable "alb_https_enabled" {
  type        = bool
  description = "Whether ALB listener uses HTTPS (443) or dev HTTP fallback (80) alongside X-Origin-Verify"
  default     = false
}

variable "cloudfront_prefix_list_id" {
  type        = string
  description = "AWS managed CloudFront origin-facing prefix list ID (e.g. pl-3b927c52 in us-east-1)"
  default     = "pl-3b927c52"
}

variable "enable_opensearch" {
  type        = bool
  description = "Allow HTTPS ingress from app/worker security groups to data tier for OpenSearch"
  default     = false
}

variable "enable_mock_payment_provider" {
  type        = bool
  description = "Allow internal TCP/3001 between ECS tasks when using test-mode mock payment provider"
  default     = true
}

variable "log_retention_days" {
  type        = number
  description = "Retention period for VPC flow logs"
  default     = 30
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
