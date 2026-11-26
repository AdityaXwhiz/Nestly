output "web_acl_arn" {
  value       = var.enable_waf ? aws_wafv2_web_acl.cloudfront[0].arn : null
  description = "ARN of the optional CloudFront WAFv2 WebACL, or null when disabled"
}
