output "media_bucket_name" {
  value       = aws_s3_bucket.media.bucket
  description = "Private media S3 bucket name"
}

output "media_bucket_arn" {
  value       = aws_s3_bucket.media.arn
  description = "Private media S3 bucket ARN"
}

output "media_cloudfront_id" {
  value       = aws_cloudfront_distribution.media.id
  description = "Media CloudFront distribution ID"
}

output "media_cloudfront_domain" {
  value       = aws_cloudfront_distribution.media.domain_name
  description = "Media CloudFront distribution domain name (properties/* only)"
}

output "media_cloudfront_arn" {
  value       = aws_cloudfront_distribution.media.arn
  description = "Media CloudFront distribution ARN"
}

output "client_bucket_name" {
  value       = aws_s3_bucket.client.bucket
  description = "Private client SPA S3 bucket name"
}

output "client_bucket_arn" {
  value       = aws_s3_bucket.client.arn
  description = "Private client SPA S3 bucket ARN"
}

output "client_cloudfront_id" {
  value       = aws_cloudfront_distribution.client.id
  description = "Client + /api/* CloudFront distribution ID"
}

output "client_cloudfront_domain" {
  value       = aws_cloudfront_distribution.client.domain_name
  description = "Single-origin CloudFront domain serving React SPA + /api/* proxy"
}

output "client_cloudfront_arn" {
  value       = aws_cloudfront_distribution.client.arn
  description = "Client + /api/* CloudFront distribution ARN"
}

output "media_bucket_policy_json" {
  value       = local.media_bucket_policy_json
  description = "Media S3 bucket policy JSON exposed for terraform test"
}

output "client_bucket_policy_json" {
  value       = local.client_bucket_policy_json
  description = "Client S3 bucket policy JSON exposed for terraform test"
}

output "api_forwarded_headers" {
  value       = aws_cloudfront_origin_request_policy.api.headers_config[0].headers[0].items
  description = "Headers explicitly forwarded by CloudFront to /api/*"
}

output "security_audit" {
  value = {
    media_public_access = {
      block_public_acls       = aws_s3_bucket_public_access_block.media.block_public_acls
      block_public_policy     = aws_s3_bucket_public_access_block.media.block_public_policy
      ignore_public_acls      = aws_s3_bucket_public_access_block.media.ignore_public_acls
      restrict_public_buckets = aws_s3_bucket_public_access_block.media.restrict_public_buckets
    }
    client_public_access = {
      block_public_acls       = aws_s3_bucket_public_access_block.client.block_public_acls
      block_public_policy     = aws_s3_bucket_public_access_block.client.block_public_policy
      ignore_public_acls      = aws_s3_bucket_public_access_block.client.ignore_public_acls
      restrict_public_buckets = aws_s3_bucket_public_access_block.client.restrict_public_buckets
    }
    media_ordered_path_patterns = [for b in aws_cloudfront_distribution.media.ordered_cache_behavior : b.path_pattern]
    client_api_behavior = one([
      for b in aws_cloudfront_distribution.client.ordered_cache_behavior : {
        cache_policy_id = b.cache_policy_id
        allowed_methods = tolist(b.allowed_methods)
      } if b.path_pattern == "/api/*"
    ])
    client_alb_custom_header_names = nonsensitive(flatten([
      for o in aws_cloudfront_distribution.client.origin : [
        for h in o.custom_header : h.name
      ]
    ]))
  }
  description = "S3 public-access and CloudFront routing posture attributes for terraform test assertions"
}
