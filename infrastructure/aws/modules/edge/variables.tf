variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "enable_waf" {
  type        = bool
  description = "Enable AWS WAFv2 WebACL on CloudFront (disabled by default to keep dev baseline lean)"
  default     = false
}

variable "waf_rate_limit" {
  type        = number
  description = "Maximum requests per 5-minute window per client IP before WAF rate-limits"
  default     = 2000
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
