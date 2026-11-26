variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used to keep S3 bucket names globally unique without AWS-calling data sources"
  default     = "123456789012"
}

variable "alb_dns_name" {
  type        = string
  description = "DNS name of the backend Application Load Balancer used as CloudFront /api/* origin"
}

variable "alb_https_enabled" {
  type        = bool
  description = "Whether CloudFront connects to the ALB origin over HTTPS (requires custom ALB ACM cert) or HTTP"
  default     = false
}

variable "origin_verify_secret" {
  type        = string
  sensitive   = true
  description = "Shared secret header injected by CloudFront as X-Origin-Verify and enforced by the ALB listener"
}

variable "waf_web_acl_arn" {
  type        = string
  description = "Optional WAFv2 WebACL ARN (CLOUDFRONT scope) for the client/API distribution"
  default     = null
}

variable "extra_cors_origins" {
  type        = list(string)
  description = "Additional allowed CORS origins on the media bucket for browser presigned uploads"
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
