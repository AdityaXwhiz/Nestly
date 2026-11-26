locals {
  opensearch_access_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountAccessWithinVpc"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.aws_account_id}:root"
        }
        Action   = "es:*"
        Resource = "arn:aws:es:${var.aws_region}:${var.aws_account_id}:domain/${var.name_prefix}-search/*"
      }
    ]
  })
}

# --------------- RDS PostgreSQL (Private, Encrypted, PITR) ---------------

resource "aws_db_subnet_group" "postgres" {
  name        = "${var.name_prefix}-pg-subnets"
  description = "Isolated private data subnets for Nestly PostgreSQL"
  subnet_ids  = var.private_data_subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-pg-subnets"
  })
}

resource "aws_db_parameter_group" "postgres" {
  name        = "${var.name_prefix}-pg16-params"
  family      = "postgres16"
  description = "Enforce TLS in transit on Nestly RDS PostgreSQL 16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = var.tags
}

resource "aws_db_instance" "postgres" {
  identifier     = "${var.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = var.pg_engine_version
  instance_class = var.pg_instance_class

  allocated_storage     = var.pg_allocated_storage
  max_allocated_storage = var.pg_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                     = var.pg_db_name
  username                    = var.pg_master_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [var.data_sg_id]
  parameter_group_name   = aws_db_parameter_group.postgres.name
  publicly_accessible    = false

  multi_az                              = var.rds_multi_az
  deletion_protection                   = var.deletion_protection
  backup_retention_period               = var.backup_retention_period
  copy_tags_to_snapshot                 = true
  skip_final_snapshot                   = var.skip_final_snapshot
  final_snapshot_identifier             = "${var.name_prefix}-postgres-final"
  ca_cert_identifier                    = "rds-ca-rsa2048-g1"
  auto_minor_version_upgrade            = true
  iam_database_authentication_enabled   = true
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-postgres"
  })
}

# --------------- ElastiCache Redis (Private, Encrypted at Rest & In Transit) ---------------

resource "aws_elasticache_subnet_group" "redis" {
  name        = "${var.name_prefix}-redis-subnets"
  description = "Isolated private data subnets for Nestly Redis"
  subnet_ids  = var.private_data_subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-redis-subnets"
  })
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.name_prefix}-redis"
  description          = "Nestly Redis replication group for cache, locks, holds, and rate limits"

  engine             = "redis"
  engine_version     = "7.1"
  port               = 6379
  node_type          = var.redis_node_type
  num_cache_clusters = var.redis_num_nodes

  automatic_failover_enabled = var.redis_num_nodes > 1
  multi_az_enabled           = var.redis_num_nodes > 1

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [var.data_sg_id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  snapshot_retention_limit   = var.redis_snapshot_retention_days
  auto_minor_version_upgrade = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-redis"
  })
}

# --------------- Optional OpenSearch Domain (Default Disabled) ---------------

resource "aws_opensearch_domain" "search" {
  count = var.enable_opensearch ? 1 : 0

  domain_name    = "${var.name_prefix}-search"
  engine_version = "OpenSearch_2.17"

  cluster_config {
    instance_type          = var.opensearch_instance_type
    instance_count         = var.opensearch_instance_count
    zone_awareness_enabled = var.opensearch_instance_count > 1

    dynamic "zone_awareness_config" {
      for_each = var.opensearch_instance_count > 1 ? [1] : []
      content {
        availability_zone_count = 2
      }
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = var.opensearch_ebs_volume_size
  }

  vpc_options {
    subnet_ids         = var.opensearch_instance_count > 1 ? slice(var.private_data_subnet_ids, 0, 2) : [var.private_data_subnet_ids[0]]
    security_group_ids = [var.data_sg_id]
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  access_policies = local.opensearch_access_policy

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-search"
  })
}
