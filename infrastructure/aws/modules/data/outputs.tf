output "rds_identifier" {
  value       = aws_db_instance.postgres.identifier
  description = "RDS PostgreSQL instance identifier"
}

output "rds_endpoint" {
  value       = aws_db_instance.postgres.endpoint
  description = "RDS PostgreSQL endpoint (host:port)"
}

output "rds_address" {
  value       = aws_db_instance.postgres.address
  description = "RDS PostgreSQL hostname"
}

output "rds_port" {
  value       = aws_db_instance.postgres.port
  description = "RDS PostgreSQL port"
}

output "rds_db_name" {
  value       = aws_db_instance.postgres.db_name
  description = "RDS PostgreSQL database name"
}

output "rds_master_user_secret_arn" {
  value       = try(aws_db_instance.postgres.master_user_secret[0].secret_arn, null)
  description = "ARN of the AWS-managed RDS master credential secret"
}

output "redis_replication_group_id" {
  value       = aws_elasticache_replication_group.redis.replication_group_id
  description = "ElastiCache Redis replication group ID"
}

output "redis_primary_endpoint_address" {
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
  description = "ElastiCache Redis primary hostname (connect using rediss:// when transit encryption is enabled)"
}

output "redis_port" {
  value       = aws_elasticache_replication_group.redis.port
  description = "ElastiCache Redis port"
}

output "opensearch_endpoint" {
  value       = var.enable_opensearch ? "https://${aws_opensearch_domain.search[0].endpoint}" : ""
  description = "OpenSearch VPC HTTPS endpoint or empty string when disabled"
}

output "opensearch_domain_arn" {
  value       = var.enable_opensearch ? aws_opensearch_domain.search[0].arn : null
  description = "OpenSearch domain ARN or null when disabled"
}

output "opensearch_access_policy_json" {
  value       = local.opensearch_access_policy
  description = "OpenSearch access policy JSON exposed for policy inspection"
}

output "security_audit" {
  value = {
    rds_publicly_accessible         = aws_db_instance.postgres.publicly_accessible
    rds_storage_encrypted           = aws_db_instance.postgres.storage_encrypted
    rds_deletion_protection         = aws_db_instance.postgres.deletion_protection
    rds_backup_retention_period     = aws_db_instance.postgres.backup_retention_period
    rds_manage_master_user_password = aws_db_instance.postgres.manage_master_user_password
    redis_at_rest_encrypted         = aws_elasticache_replication_group.redis.at_rest_encryption_enabled
    redis_transit_encrypted         = aws_elasticache_replication_group.redis.transit_encryption_enabled
    opensearch_count                = length(aws_opensearch_domain.search)
  }
  description = "Non-sensitive data-tier posture attributes for terraform test assertions"
}
