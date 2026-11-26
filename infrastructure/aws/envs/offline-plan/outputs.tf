output "client_cloudfront_url" {
  value       = "https://${module.storage_cdn.client_cloudfront_domain}"
  description = "Primary HTTPS URL serving React SPA and /api/* reverse proxy"
}

output "media_cloudfront_url" {
  value       = "https://${module.storage_cdn.media_cloudfront_domain}"
  description = "HTTPS CDN URL serving confirmed property media (properties/* only)"
}

output "client_bucket_name" {
  value       = module.storage_cdn.client_bucket_name
  description = "Private client S3 bucket name for CI asset sync"
}

output "media_bucket_name" {
  value       = module.storage_cdn.media_bucket_name
  description = "Private media S3 bucket name"
}

output "client_cloudfront_id" {
  value       = module.storage_cdn.client_cloudfront_id
  description = "Client CloudFront distribution ID for cache invalidation"
}

output "ecr_server_repository_url" {
  value       = module.compute.ecr_server_repository_url
  description = "Unified nestly-server ECR repository URL"
}

output "ecs_cluster_name" {
  value       = module.compute.ecs_cluster_name
  description = "ECS cluster name"
}

output "ecs_services" {
  value = {
    api              = module.compute.api_service_name
    worker_scheduler = module.compute.worker_scheduler_service_name
    worker_consumer  = module.compute.worker_consumer_service_name
  }
  description = "ECS service names"
}

output "init_task_definition_family" {
  value       = module.compute.init_task_definition_family
  description = "One-off init/migration task definition family"
}

output "github_deploy_role_arn" {
  value       = module.ci_deploy.github_deploy_role_arn
  description = "IAM role ARN assumed by GitHub Actions OIDC deploy workflow"
}

output "secret_names" {
  value       = module.compute.secret_names
  description = "Secrets Manager secret names (populate app secrets manually outside Terraform)"
}

output "rds_master_user_secret_arn" {
  value       = module.data.rds_master_user_secret_arn
  description = "AWS-managed RDS master credential Secrets Manager ARN"
}

output "alerts_sns_topic_arn" {
  value       = module.observability.alerts_sns_topic_arn
  description = "SNS topic ARN for CloudWatch alarms"
}

# Exposed JSON policies & metadata for terraform test validation (Change #5)
output "policy_documents_for_test" {
  value = {
    ecs_execution    = module.compute.ecs_execution_iam_policy_json
    api_task         = module.compute.api_task_iam_policy_json
    worker_scheduler = module.compute.worker_scheduler_iam_policy_json
    worker_consumer  = module.compute.worker_consumer_iam_policy_json
    init_task        = module.compute.init_task_iam_policy_json
    media_bucket     = module.storage_cdn.media_bucket_policy_json
    client_bucket    = module.storage_cdn.client_bucket_policy_json
    github_trust     = module.ci_deploy.github_deploy_trust_policy_json
    github_deploy    = module.ci_deploy.github_deploy_iam_policy_json
  }
  description = "IAM & S3 policy JSON documents exposed for automated terraform test verification"
}

output "api_forwarded_headers_for_test" {
  value       = module.storage_cdn.api_forwarded_headers
  description = "Headers forwarded by CloudFront to /api/*"
}

output "audit_summary_for_test" {
  value = {
    data        = module.data.security_audit
    messaging   = module.messaging.redrive_audit
    storage_cdn = module.storage_cdn.security_audit
    compute     = module.compute.hardening_audit
    edge_waf    = module.edge.web_acl_arn != null
  }
  description = "Aggregated non-sensitive infrastructure posture summary for terraform test assertions"
}
