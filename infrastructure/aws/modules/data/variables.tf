variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "aws_region" {
  type        = string
  description = "AWS region (explicit variable)"
  default     = "us-east-1"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used in OpenSearch resource policy (explicit variable; avoids aws_caller_identity data source)"
  default     = "123456789012"
}

variable "private_data_subnet_ids" {
  type        = list(string)
  description = "Isolated private data subnet IDs across at least two AZs"
}

variable "data_sg_id" {
  type        = string
  description = "Security group ID protecting private data tier"
}

# PostgreSQL variables
variable "pg_engine_version" {
  type        = string
  description = "PostgreSQL engine version"
  default     = "16.6"
}

variable "pg_instance_class" {
  type        = string
  description = "RDS instance class"
  default     = "db.t4g.micro"
}

variable "pg_allocated_storage" {
  type        = number
  description = "Initial RDS gp3 storage size in GB"
  default     = 20
}

variable "pg_max_allocated_storage" {
  type        = number
  description = "Maximum RDS autoscaling storage limit in GB"
  default     = 100
}

variable "pg_db_name" {
  type        = string
  description = "Initial PostgreSQL database name"
  default     = "nestly"
}

variable "pg_master_username" {
  type        = string
  description = "RDS master admin username (password is AWS-managed via Secrets Manager)"
  default     = "nestly_admin"
}

variable "rds_multi_az" {
  type        = bool
  description = "Enable Multi-AZ standby for RDS PostgreSQL"
  default     = false
}

variable "deletion_protection" {
  type        = bool
  description = "Enable deletion protection on RDS PostgreSQL"
  default     = true
}

variable "backup_retention_period" {
  type        = number
  description = "Automated PITR backup retention days for RDS"
  default     = 7
}

variable "skip_final_snapshot" {
  type        = bool
  description = "Skip final RDS snapshot on destroy (false recommended for safety)"
  default     = false
}

# ElastiCache Redis variables
variable "redis_node_type" {
  type        = string
  description = "ElastiCache Redis node type"
  default     = "cache.t4g.micro"
}

variable "redis_num_nodes" {
  type        = number
  description = "Number of Redis cache nodes (set >= 2 to enable Multi-AZ automatic failover)"
  default     = 1
}

variable "redis_snapshot_retention_days" {
  type        = number
  description = "Days to retain automated Redis RDB snapshots"
  default     = 1
}

# Optional OpenSearch variables (default false -> PostgreSQL full-text fallback)
variable "enable_opensearch" {
  type        = bool
  description = "Deploy a VPC-only Amazon OpenSearch Service domain (false falls back to PostgreSQL FTS)"
  default     = false
}

variable "opensearch_instance_type" {
  type        = string
  description = "OpenSearch data node instance type when enabled"
  default     = "t3.small.search"
}

variable "opensearch_instance_count" {
  type        = number
  description = "Number of OpenSearch data nodes when enabled"
  default     = 1
}

variable "opensearch_ebs_volume_size" {
  type        = number
  description = "OpenSearch gp3 EBS volume size in GB per node"
  default     = 10
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
