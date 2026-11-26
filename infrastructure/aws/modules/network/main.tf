locals {
  az_count  = length(var.azs)
  nat_count = var.single_nat_gateway ? 1 : local.az_count

  flow_logs_trust_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowVpcFlowLogsAssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "vpc-flow-logs.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  flow_logs_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteVpcFlowLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams"
        ]
        Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
      }
    ]
  })

  interface_endpoints = var.enable_interface_endpoints ? {
    sqs            = "sqs"
    secretsmanager = "secretsmanager"
    ecr_api        = "ecr.api"
    ecr_dkr        = "ecr.dkr"
    logs           = "logs"
  } : {}
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-vpc"
  })
}

# Lock down default security group with zero rules
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-default-sg-locked"
  })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-igw"
  })
}

# --------------- Subnets (Public, Private App, Private Data) ---------------

resource "aws_subnet" "public" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-public-${var.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private_app" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index + 4)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-app-${var.azs[count.index]}"
    Tier = "private-app"
  })
}

resource "aws_subnet" "private_data" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-data-${var.azs[count.index]}"
    Tier = "private-data"
  })
}

# --------------- NAT Gateways & Route Tables ---------------

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"

  depends_on = [aws_internet_gateway.this]

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-nat-eip-${count.index}"
  })
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  depends_on = [aws_internet_gateway.this]

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-nat-${count.index}"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-public-rt"
  })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private_app" {
  count  = local.nat_count
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-app-rt-${count.index}"
  })
}

resource "aws_route" "private_app_nat" {
  count                  = local.nat_count
  route_table_id         = aws_route_table.private_app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index].id
}

resource "aws_route_table_association" "private_app" {
  count          = local.az_count
  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private_app[var.single_nat_gateway ? 0 : count.index].id
}

# Isolated data route table (local VPC routes only — zero internet/NAT route)
resource "aws_route_table" "private_data" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-data-rt"
  })
}

resource "aws_route_table_association" "private_data" {
  count          = local.az_count
  subnet_id      = aws_subnet.private_data[count.index].id
  route_table_id = aws_route_table.private_data.id
}

# --------------- Security Groups (HLD Section 4) ---------------

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb-sg"
  description = "ALB security group: ingress from CloudFront prefix list only; egress to API tasks only"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alb-sg"
  })
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront_https" {
  count             = var.alb_https_enabled ? 1 : 0
  security_group_id = aws_security_group.alb.id
  description       = "Allow HTTPS 443 strictly from CloudFront origin-facing prefix list"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = var.cloudfront_prefix_list_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront_http" {
  count             = var.alb_https_enabled ? 0 : 1
  security_group_id = aws_security_group.alb.id
  description       = "Allow HTTP 80 from CloudFront prefix list when ACM cert is not configured yet"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  prefix_list_id    = var.cloudfront_prefix_list_id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward traffic strictly to API ECS security group on app port"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_security_group" "api" {
  name        = "${var.name_prefix}-api-sg"
  description = "API ECS task security group: ingress strictly from ALB on app port"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-api-sg"
  })
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "Allow traffic from ALB security group on API container port"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "api_to_data_pg" {
  security_group_id            = aws_security_group.api.id
  description                  = "Allow PostgreSQL egress to data tier"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.data.id
}

resource "aws_vpc_security_group_egress_rule" "api_to_data_redis" {
  security_group_id            = aws_security_group.api.id
  description                  = "Allow TLS Redis egress to data tier"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.data.id
}

resource "aws_vpc_security_group_egress_rule" "api_https_out" {
  security_group_id = aws_security_group.api.id
  description       = "Allow HTTPS 443 egress for AWS VPC endpoints, S3, and external webhooks"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "api_to_mock_provider" {
  count                        = var.enable_mock_payment_provider ? 1 : 0
  security_group_id            = aws_security_group.api.id
  description                  = "Allow internal mock payment provider calls when enabled"
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_security_group" "worker" {
  name        = "${var.name_prefix}-worker-sg"
  description = "Worker and one-off init task security group"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-worker-sg"
  })
}

resource "aws_vpc_security_group_ingress_rule" "worker_mock_provider_from_api" {
  count                        = var.enable_mock_payment_provider ? 1 : 0
  security_group_id            = aws_security_group.worker.id
  description                  = "Allow API tasks to reach optional internal mock payment provider on 3001"
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "worker_mock_provider_from_self" {
  count                        = var.enable_mock_payment_provider ? 1 : 0
  security_group_id            = aws_security_group.worker.id
  description                  = "Allow scheduler worker reconciler to reach mock payment provider on 3001"
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_vpc_security_group_egress_rule" "worker_to_data_pg" {
  security_group_id            = aws_security_group.worker.id
  description                  = "Allow PostgreSQL egress from workers and init tasks to data tier"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.data.id
}

resource "aws_vpc_security_group_egress_rule" "worker_to_data_redis" {
  security_group_id            = aws_security_group.worker.id
  description                  = "Allow TLS Redis egress from workers to data tier"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.data.id
}

resource "aws_vpc_security_group_egress_rule" "worker_https_out" {
  security_group_id = aws_security_group.worker.id
  description       = "Allow HTTPS 443 egress for SQS, S3, Secrets Manager, and ECR"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "worker_mock_provider_self" {
  count                        = var.enable_mock_payment_provider ? 1 : 0
  security_group_id            = aws_security_group.worker.id
  description                  = "Allow scheduler reconciler calls to internal mock payment provider on 3001"
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_security_group" "data" {
  name        = "${var.name_prefix}-data-sg"
  description = "Data tier security group (RDS Postgres, ElastiCache Redis, optional OpenSearch)"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-data-sg"
  })
}

resource "aws_vpc_security_group_ingress_rule" "data_pg_from_api" {
  security_group_id            = aws_security_group.data.id
  description                  = "Allow PostgreSQL 5432 from API ECS tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "data_pg_from_worker" {
  security_group_id            = aws_security_group.data.id
  description                  = "Allow PostgreSQL 5432 from Worker and init tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_vpc_security_group_ingress_rule" "data_redis_from_api" {
  security_group_id            = aws_security_group.data.id
  description                  = "Allow TLS Redis 6379 from API ECS tasks"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "data_redis_from_worker" {
  security_group_id            = aws_security_group.data.id
  description                  = "Allow TLS Redis 6379 from Worker tasks"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_vpc_security_group_ingress_rule" "data_opensearch_from_api" {
  count                        = var.enable_opensearch ? 1 : 0
  security_group_id            = aws_security_group.data.id
  description                  = "Allow OpenSearch HTTPS 443 from API tasks"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "data_opensearch_from_worker" {
  count                        = var.enable_opensearch ? 1 : 0
  security_group_id            = aws_security_group.data.id
  description                  = "Allow OpenSearch HTTPS 443 from Worker and init tasks"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.worker.id
}

# --------------- VPC Endpoints (HLD Section 4) ---------------

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = concat(
    aws_route_table.private_app[*].id,
    [aws_route_table.private_data.id],
  )

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-s3-gateway-vpce"
  })
}

resource "aws_security_group" "vpce" {
  count       = var.enable_interface_endpoints ? 1 : 0
  name        = "${var.name_prefix}-vpce-sg"
  description = "Allow HTTPS 443 strictly from Nestly private VPC CIDR to AWS interface endpoints"
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-vpce-sg"
  })
}

resource "aws_vpc_security_group_ingress_rule" "vpce_https" {
  count             = var.enable_interface_endpoints ? 1 : 0
  security_group_id = aws_security_group.vpce[0].id
  description       = "Allow HTTPS 443 from private VPC CIDR"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = aws_vpc.this.cidr_block
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private_app[*].id
  security_group_ids  = [aws_security_group.vpce[0].id]

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-${each.key}-vpce"
  })
}

# --------------- VPC Flow Logs ---------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/vpc/${var.name_prefix}/flow-logs"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

resource "aws_iam_role" "flow_logs" {
  name               = "${var.name_prefix}-vpc-flow-logs-role"
  assume_role_policy = local.flow_logs_trust_policy

  tags = var.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "${var.name_prefix}-vpc-flow-logs-policy"
  role   = aws_iam_role.flow_logs.id
  policy = local.flow_logs_policy
}

resource "aws_flow_log" "vpc" {
  iam_role_arn    = aws_iam_role.flow_logs.arn
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
  traffic_type    = "ALL"
  vpc_id          = aws_vpc.this.id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-vpc-flow-log"
  })
}
