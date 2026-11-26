locals {
  alb_https_enabled      = var.alb_acm_certificate_arn != null && var.alb_acm_certificate_arn != ""
  all_queue_and_dlq_arns = sort(concat(values(var.queue_arns), values(var.dlq_arns)))
  server_image           = "${aws_ecr_repository.server.repository_url}:${var.server_image_tag}"

  media_object_prefixes = [
    "${var.media_bucket_arn}/uploads/pending/*",
    "${var.media_bucket_arn}/properties/*",
  ]

  app_secret_arns = [
    aws_secretsmanager_secret.database_url.arn,
    aws_secretsmanager_secret.redis_url.arn,
    aws_secretsmanager_secret.jwt_access_secret.arn,
    aws_secretsmanager_secret.payment_webhook_secret.arn,
  ]

  ecs_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEcsTasksAssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  # Execution role policy: pull nestly-server image, read app secrets, write CloudWatch logs
  ecs_execution_policy_json = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AllowEcrAuthToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "AllowEcrPullServerImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = aws_ecr_repository.server.arn
      },
      {
        Sid    = "AllowReadAppSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = local.app_secret_arns
      },
      {
        Sid    = "AllowWriteCloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [
          "${aws_cloudwatch_log_group.api.arn}:*",
          "${aws_cloudwatch_log_group.worker.arn}:*",
          "${aws_cloudwatch_log_group.init.arn}:*",
        ]
      }
    ]
  })

  # API task role: S3 presigning / promotion / deletion strictly on uploads/pending/* & properties/* + optional OpenSearch
  api_task_policy_statements = concat(
    [
      {
        Sid    = "AllowMediaObjectAccess"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = local.media_object_prefixes
      },
      {
        Sid      = "AllowMediaBucketList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.media_bucket_arn
      }
    ],
    var.enable_opensearch ? [
      {
        Sid    = "AllowOpenSearchQuery"
        Effect = "Allow"
        Action = [
          "es:ESHttpGet",
          "es:ESHttpPost",
        ]
        Resource = "${var.opensearch_domain_arn}/*"
      }
    ] : []
  )

  api_task_policy_json = jsonencode({
    Version   = "2012-10-17"
    Statement = local.api_task_policy_statements
  })

  # Scheduler worker: SQS publish/attributes + S3 cleanup on pending/properties ONLY (Change #9)
  worker_scheduler_policy_json = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowSqsQueueAndDlqOperations"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:SendMessage",
        ]
        Resource = local.all_queue_and_dlq_arns
      },
      {
        Sid    = "AllowMediaObjectCleanup"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = local.media_object_prefixes
      },
      {
        Sid      = "AllowMediaBucketList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.media_bucket_arn
      }
    ]
  })

  # Consumer worker: SQS consume/delete/visibility/attributes + S3 object delete + optional OpenSearch indexing (Change #9)
  worker_consumer_policy_statements = concat(
    [
      {
        Sid    = "AllowSqsQueueAndDlqOperations"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:SendMessage",
        ]
        Resource = local.all_queue_and_dlq_arns
      },
      {
        Sid    = "AllowMediaObjectAccess"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = local.media_object_prefixes
      },
      {
        Sid      = "AllowMediaBucketList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.media_bucket_arn
      }
    ],
    var.enable_opensearch ? [
      {
        Sid    = "AllowOpenSearchIndexing"
        Effect = "Allow"
        Action = [
          "es:ESHttpGet",
          "es:ESHttpPost",
          "es:ESHttpPut",
          "es:ESHttpDelete",
          "es:ESHttpHead",
        ]
        Resource = "${var.opensearch_domain_arn}/*"
      }
    ] : []
  )

  worker_consumer_policy_json = jsonencode({
    Version   = "2012-10-17"
    Statement = local.worker_consumer_policy_statements
  })

  # One-off init task role: NO queue or bucket create permissions; optional OpenSearch alias creation only (Change #3)
  init_task_policy_statements = var.enable_opensearch ? [
    {
      Sid    = "AllowOpenSearchAliasSetup"
      Effect = "Allow"
      Action = [
        "es:ESHttpGet",
        "es:ESHttpPost",
        "es:ESHttpPut",
        "es:ESHttpHead",
      ]
      Resource = "${var.opensearch_domain_arn}/*"
    }
  ] : []

  init_task_policy_json = jsonencode({
    Version   = "2012-10-17"
    Statement = local.init_task_policy_statements
  })

  common_server_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "TRUST_PROXY", value = "2" },
    { name = "DB_SSL", value = "true" },
    { name = "DB_SSL_CA_PATH", value = "/etc/ssl/certs/aws-rds-global-bundle.pem" },
    { name = "PGSSLMODE", value = "verify-full" },
    { name = "PGSSLROOTCERT", value = "/etc/ssl/certs/aws-rds-global-bundle.pem" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "PUBLISHER", value = "sqs" },
    { name = "PAYMENT_PROVIDER", value = "mock" },
    { name = "PAYMENT_PROVIDER_URL", value = var.enable_mock_payment_provider ? "http://mock-provider.${var.name_prefix}.local:3001" : "https://payments.invalid" },
    { name = "S3_BUCKET", value = var.media_bucket_name },
    { name = "S3_FORCE_PATH_STYLE", value = "false" },
    { name = "MEDIA_PUBLIC_BASE_URL", value = "https://${var.media_cloudfront_domain}" },
    { name = "CORS_ORIGINS", value = "https://${var.client_cloudfront_domain}" },
    { name = "SQS_QUEUE_URL_NOTIFICATIONS", value = var.queue_urls["notifications"] },
    { name = "SQS_QUEUE_URL_PROVIDER_ACTIONS", value = var.queue_urls["provider-actions"] },
    { name = "SQS_QUEUE_URL_ANALYTICS", value = var.queue_urls["analytics"] },
    { name = "SQS_QUEUE_URL_SEARCH_INDEX", value = var.queue_urls["search-index"] },
    { name = "OPENSEARCH_ENDPOINT", value = var.opensearch_endpoint },
    { name = "OPENSEARCH_INDEX_PREFIX", value = var.name_prefix },
    { name = "INIT_TARGET", value = "aws" },
    { name = "API_METRICS_PORT", value = "9100" },
    { name = "WORKER_METRICS_PORT", value = "9101" },
  ]

  common_server_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
    { name = "JWT_ACCESS_SECRET", valueFrom = aws_secretsmanager_secret.jwt_access_secret.arn },
    { name = "PAYMENT_WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.payment_webhook_secret.arn },
  ]
}

# ==============================================================================
# 1. ECR Repository (nestly-server ONLY — client lives in S3 + CloudFront, Change #4)
# ==============================================================================

resource "aws_ecr_repository" "server" {
  name                 = "${var.name_prefix}-nestly-server"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-nestly-server"
  })
}

resource "aws_ecr_lifecycle_policy" "server" {
  repository = aws_ecr_repository.server.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images older than 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep last 10 tagged server images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha-", "v", "release-", "initial"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# ==============================================================================
# 2. Secrets Manager Containers (Empty containers populated out-of-band, Change #6)
# ==============================================================================

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name_prefix}/database-url"
  description             = "PostgreSQL connection URL with TLS (populate manually outside Terraform)"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${var.name_prefix}/redis-url"
  description             = "ElastiCache Redis rediss:// URL (populate manually outside Terraform)"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret" "jwt_access_secret" {
  name                    = "${var.name_prefix}/jwt-access-secret"
  description             = "HS256 JWT signing secret >= 32 chars (populate manually outside Terraform)"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret" "payment_webhook_secret" {
  name                    = "${var.name_prefix}/payment-webhook-secret"
  description             = "HMAC webhook secret >= 32 chars distinct from JWT secret (populate manually outside Terraform)"
  recovery_window_in_days = 7
  tags                    = var.tags
}

# Only generated secret (Change #6): origin-verification header between CloudFront and ALB
resource "aws_secretsmanager_secret" "origin_verify" {
  name                    = "${var.name_prefix}/origin-verify-header"
  description             = "CloudFront -> ALB X-Origin-Verify shared header value"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "origin_verify" {
  secret_id     = aws_secretsmanager_secret.origin_verify.id
  secret_string = var.origin_verify_secret
}

# ==============================================================================
# 3. CloudWatch Log Groups
# ==============================================================================

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/ecs/${var.name_prefix}/api"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/ecs/${var.name_prefix}/worker"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "init" {
  name              = "/aws/ecs/${var.name_prefix}/init"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# ==============================================================================
# 4. IAM Roles & Scoped Inline Policies (Changes #5 & #9)
# ==============================================================================

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.name_prefix}-ecs-exec-role"
  assume_role_policy = local.ecs_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "${var.name_prefix}-ecs-exec-policy"
  role   = aws_iam_role.ecs_execution.id
  policy = local.ecs_execution_policy_json
}

resource "aws_iam_role" "api_task" {
  name               = "${var.name_prefix}-api-task-role"
  assume_role_policy = local.ecs_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy" "api_task" {
  name   = "${var.name_prefix}-api-task-policy"
  role   = aws_iam_role.api_task.id
  policy = local.api_task_policy_json
}

resource "aws_iam_role" "worker_scheduler_task" {
  name               = "${var.name_prefix}-worker-scheduler-role"
  assume_role_policy = local.ecs_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy" "worker_scheduler_task" {
  name   = "${var.name_prefix}-worker-scheduler-policy"
  role   = aws_iam_role.worker_scheduler_task.id
  policy = local.worker_scheduler_policy_json
}

resource "aws_iam_role" "worker_consumer_task" {
  name               = "${var.name_prefix}-worker-consumer-role"
  assume_role_policy = local.ecs_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy" "worker_consumer_task" {
  name   = "${var.name_prefix}-worker-consumer-policy"
  role   = aws_iam_role.worker_consumer_task.id
  policy = local.worker_consumer_policy_json
}

resource "aws_iam_role" "init_task" {
  name               = "${var.name_prefix}-init-task-role"
  assume_role_policy = local.ecs_assume_role_policy
  tags               = var.tags
}

resource "aws_iam_role_policy" "init_task" {
  count  = var.enable_opensearch ? 1 : 0
  name   = "${var.name_prefix}-init-task-policy"
  role   = aws_iam_role.init_task.id
  policy = local.init_task_policy_json
}

# ==============================================================================
# 5. Application Load Balancer & Origin-Verify Listener Rule (Changes #1 & #11)
# ==============================================================================

resource "aws_lb" "api" {
  name                       = "${var.name_prefix}-api-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [var.alb_sg_id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-api-alb"
  })
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name_prefix}-api-tg"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30 # Matches ECS stopTimeout and Node 20s shutdown drain (Change #11)

  health_check {
    enabled             = true
    path                = "/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-api-tg"
  })
}

resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = local.alb_https_enabled ? 443 : 80
  protocol          = local.alb_https_enabled ? "HTTPS" : "HTTP"
  ssl_policy        = local.alb_https_enabled ? "ELBSecurityPolicy-TLS13-1-2-2021-06" : null
  certificate_arn   = local.alb_https_enabled ? var.alb_acm_certificate_arn : null

  # Default action denies direct ALB requests missing X-Origin-Verify (Change #1)
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"Direct ALB origin access forbidden\"}"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "origin_verify" {
  listener_arn = aws_lb_listener.api.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [var.origin_verify_secret]
    }
  }
}

# ==============================================================================
# 6. ECS Cluster, Private Cloud Map Namespace & Task Definitions (Change #11)
# ==============================================================================

resource "aws_ecs_cluster" "main" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-cluster"
  })
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  count       = var.enable_mock_payment_provider ? 1 : 0
  name        = "${var.name_prefix}.local"
  description = "Private DNS namespace for internal optional test-mode mock payment provider"
  vpc         = var.vpc_id
  tags        = var.tags
}

resource "aws_service_discovery_service" "mock_provider" {
  count = var.enable_mock_payment_provider ? 1 : 0
  name  = "mock-provider"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal[0].id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "api"
      image                  = local.server_image
      essential              = true
      command                = ["node", "src/server.js"]
      stopTimeout            = 30
      readonlyRootFilesystem = true
      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]
      environment = local.common_server_env
      secrets     = local.common_server_secrets
      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        }
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "worker_scheduler" {
  family                   = "${var.name_prefix}-worker-scheduler"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.worker_scheduler_task.arn

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "worker-scheduler"
      image                  = local.server_image
      essential              = true
      command                = ["node", "src/workers/index.js"]
      stopTimeout            = 30
      readonlyRootFilesystem = true
      environment = concat(local.common_server_env, [
        { name = "WORKER_ROLES", value = "publisher,schedulers" },
        { name = "WORKER_HEARTBEAT_FILE", value = "/tmp/worker-heartbeat" },
      ])
      secrets = local.common_server_secrets
      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        }
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "test -f /tmp/worker-heartbeat"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "scheduler"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "worker_consumer" {
  family                   = "${var.name_prefix}-worker-consumer"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.worker_consumer_task.arn

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "worker-consumer"
      image                  = local.server_image
      essential              = true
      command                = ["node", "src/workers/index.js"]
      stopTimeout            = 30
      readonlyRootFilesystem = true
      environment = concat(local.common_server_env, [
        { name = "WORKER_ROLES", value = "notification,provider-actions,analytics,search-index" },
        { name = "WORKER_HEARTBEAT_FILE", value = "/tmp/worker-heartbeat" },
      ])
      secrets = local.common_server_secrets
      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        }
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "test -f /tmp/worker-heartbeat"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "consumer"
        }
      }
    }
  ])

  tags = var.tags
}

# One-off init & migration task definition (INIT_TARGET=aws -> migrations + optional OpenSearch alias only, Change #3)
resource "aws_ecs_task_definition" "init" {
  family                   = "${var.name_prefix}-init"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.init_task.arn

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "init"
      image                  = local.server_image
      essential              = true
      command                = ["node", "src/infrastructure/init.js"]
      stopTimeout            = 30
      readonlyRootFilesystem = true
      environment            = local.common_server_env
      secrets                = local.common_server_secrets
      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.init.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "init"
        }
      }
    }
  ])

  tags = var.tags
}

# Optional mock payment provider task & service for dev/test deployments without external gateway
resource "aws_ecs_task_definition" "mock_provider" {
  count                    = var.enable_mock_payment_provider ? 1 : 0
  family                   = "${var.name_prefix}-mock-provider"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.init_task.arn

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = "mock-provider"
      image                  = local.server_image
      essential              = true
      command                = ["node", "src/infrastructure/payment/mockProvider.js"]
      stopTimeout            = 30
      readonlyRootFilesystem = true
      portMappings = [
        {
          containerPort = 3001
          protocol      = "tcp"
        }
      ]
      environment = concat(local.common_server_env, [
        { name = "MOCK_PROVIDER_PORT", value = "3001" },
      ])
      secrets = local.common_server_secrets
      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "mock-provider"
        }
      }
    }
  ])

  tags = var.tags
}

# ==============================================================================
# 7. ECS Services (Circuit Breaker, No Exec, Multi-AZ API, Single Scheduler)
# ==============================================================================

resource "aws_ecs_service" "api" {
  name                              = "${var.name_prefix}-api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.api_desired_count
  launch_type                       = "FARGATE"
  enable_execute_command            = false
  health_check_grace_period_seconds = 30

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.api_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener_rule.origin_verify]

  tags = var.tags
}

resource "aws_ecs_service" "worker_scheduler" {
  name                   = "${var.name_prefix}-worker-scheduler"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.worker_scheduler.arn
  desired_count          = 1 # Single advisory-locked scheduler instance (Change #11)
  launch_type            = "FARGATE"
  enable_execute_command = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.worker_sg_id]
    assign_public_ip = false
  }

  tags = var.tags
}

resource "aws_ecs_service" "worker_consumer" {
  name                   = "${var.name_prefix}-worker-consumer"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.worker_consumer.arn
  desired_count          = var.worker_consumer_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.worker_sg_id]
    assign_public_ip = false
  }

  tags = var.tags
}

resource "aws_ecs_service" "mock_provider" {
  count                  = var.enable_mock_payment_provider ? 1 : 0
  name                   = "${var.name_prefix}-mock-provider"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.mock_provider[0].arn
  desired_count          = 1
  launch_type            = "FARGATE"
  enable_execute_command = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.worker_sg_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.mock_provider[0].arn
  }

  tags = var.tags
}

# ==============================================================================
# 8. Application Auto Scaling (API CPU Target Tracking + Consumer SQS Depth)
# ==============================================================================

resource "aws_appautoscaling_target" "api" {
  max_capacity       = 6
  min_capacity       = var.api_desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name_prefix}-api-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "worker_consumer" {
  max_capacity       = 6
  min_capacity       = var.worker_consumer_desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker_consumer.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_consumer_sqs_depth" {
  name               = "${var.name_prefix}-consumer-sqs-backlog"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker_consumer.resource_id
  scalable_dimension = aws_appautoscaling_target.worker_consumer.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker_consumer.service_namespace

  target_tracking_scaling_policy_configuration {
    customized_metric_specification {
      metrics {
        id    = "q_notif"
        label = "Notifications queue depth"
        metric_stat {
          metric {
            namespace   = "AWS/SQS"
            metric_name = "ApproximateNumberOfMessagesVisible"
            dimensions {
              name  = "QueueName"
              value = var.queue_names["notifications"]
            }
          }
          stat = "Sum"
        }
        return_data = false
      }
      metrics {
        id    = "q_provider"
        label = "Provider actions queue depth"
        metric_stat {
          metric {
            namespace   = "AWS/SQS"
            metric_name = "ApproximateNumberOfMessagesVisible"
            dimensions {
              name  = "QueueName"
              value = var.queue_names["provider-actions"]
            }
          }
          stat = "Sum"
        }
        return_data = false
      }
      metrics {
        id          = "total_backlog"
        expression  = "q_notif + q_provider"
        label       = "Combined critical SQS backlog"
        return_data = true
      }
    }
    target_value       = 50
    scale_in_cooldown  = 180
    scale_out_cooldown = 60
  }
}
