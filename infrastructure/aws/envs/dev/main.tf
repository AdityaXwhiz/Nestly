locals {
  name_prefix       = "${var.project_name}-${var.environment}"
  alb_https_enabled = var.alb_acm_certificate_arn != null && var.alb_acm_certificate_arn != ""

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# Only generated secret in Terraform state (Change #6): origin verification shared between CloudFront and ALB (Change #1)
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

module "network" {
  source = "../../modules/network"

  name_prefix                  = local.name_prefix
  aws_region                   = var.aws_region
  vpc_cidr                     = var.vpc_cidr
  azs                          = var.azs
  single_nat_gateway           = var.single_nat_gateway
  enable_interface_endpoints   = var.enable_interface_endpoints
  alb_https_enabled            = local.alb_https_enabled
  cloudfront_prefix_list_id    = var.cloudfront_prefix_list_id
  enable_opensearch            = var.enable_opensearch
  enable_mock_payment_provider = var.enable_mock_payment_provider
  tags                         = local.common_tags
}

module "data" {
  source = "../../modules/data"

  name_prefix             = local.name_prefix
  aws_region              = var.aws_region
  aws_account_id          = var.aws_account_id
  private_data_subnet_ids = module.network.private_data_subnet_ids
  data_sg_id              = module.network.data_sg_id
  pg_instance_class       = var.pg_instance_class
  rds_multi_az            = var.rds_multi_az
  deletion_protection     = var.deletion_protection
  backup_retention_period = var.backup_retention_period
  skip_final_snapshot     = var.skip_final_snapshot
  redis_node_type         = var.redis_node_type
  redis_num_nodes         = var.redis_num_nodes
  enable_opensearch       = var.enable_opensearch
  tags                    = local.common_tags
}

module "messaging" {
  source = "../../modules/messaging"

  name_prefix = local.name_prefix
  tags        = local.common_tags
}

module "edge" {
  source = "../../modules/edge"

  name_prefix = local.name_prefix
  enable_waf  = var.enable_waf
  tags        = local.common_tags
}

module "storage_cdn" {
  source = "../../modules/storage_cdn"

  name_prefix          = local.name_prefix
  aws_account_id       = var.aws_account_id
  alb_dns_name         = module.compute.alb_dns_name
  alb_https_enabled    = local.alb_https_enabled
  origin_verify_secret = random_password.origin_verify.result
  waf_web_acl_arn      = module.edge.web_acl_arn
  tags                 = local.common_tags
}

module "compute" {
  source = "../../modules/compute"

  name_prefix                   = local.name_prefix
  aws_region                    = var.aws_region
  vpc_id                        = module.network.vpc_id
  public_subnet_ids             = module.network.public_subnet_ids
  private_app_subnet_ids        = module.network.private_app_subnet_ids
  alb_sg_id                     = module.network.alb_sg_id
  api_sg_id                     = module.network.api_sg_id
  worker_sg_id                  = module.network.worker_sg_id
  alb_acm_certificate_arn       = var.alb_acm_certificate_arn
  deletion_protection           = var.deletion_protection
  origin_verify_secret          = random_password.origin_verify.result
  media_bucket_name             = module.storage_cdn.media_bucket_name
  media_bucket_arn              = module.storage_cdn.media_bucket_arn
  media_cloudfront_domain       = module.storage_cdn.media_cloudfront_domain
  client_cloudfront_domain      = module.storage_cdn.client_cloudfront_domain
  queue_urls                    = module.messaging.queue_urls
  queue_names                   = module.messaging.queue_names
  queue_arns                    = module.messaging.queue_arns
  dlq_arns                      = module.messaging.dlq_arns
  opensearch_endpoint           = module.data.opensearch_endpoint
  opensearch_domain_arn         = module.data.opensearch_domain_arn
  enable_opensearch             = var.enable_opensearch
  enable_mock_payment_provider  = var.enable_mock_payment_provider
  server_image_tag              = var.server_image_tag
  api_desired_count             = var.api_desired_count
  worker_consumer_desired_count = var.worker_consumer_desired_count
  tags                          = local.common_tags
}

module "observability" {
  source = "../../modules/observability"

  name_prefix                  = local.name_prefix
  alert_email                  = var.alert_email
  queue_names                  = module.messaging.queue_names
  dlq_names                    = module.messaging.dlq_names
  alb_arn_suffix               = module.compute.alb_arn_suffix
  rds_identifier               = module.data.rds_identifier
  redis_replication_group_id   = module.data.redis_replication_group_id
  ecs_cluster_name             = module.compute.ecs_cluster_name
  api_service_name             = module.compute.api_service_name
  worker_consumer_service_name = module.compute.worker_consumer_service_name
  tags                         = local.common_tags
}

module "ci_deploy" {
  source = "../../modules/ci_deploy"

  name_prefix               = local.name_prefix
  aws_region                = var.aws_region
  aws_account_id            = var.aws_account_id
  github_repo               = var.github_repo
  github_environment        = var.github_environment
  ecr_server_repository_arn = module.compute.ecr_server_repository_arn
  client_bucket_arn         = module.storage_cdn.client_bucket_arn
  client_cloudfront_arn     = module.storage_cdn.client_cloudfront_arn
  ecs_cluster_name          = module.compute.ecs_cluster_name
  ecs_cluster_arn           = module.compute.ecs_cluster_arn
  ecs_service_names = [
    module.compute.api_service_name,
    module.compute.worker_scheduler_service_name,
    module.compute.worker_consumer_service_name,
  ]
  init_task_definition_family = module.compute.init_task_definition_family
  pass_role_arns = [
    module.compute.execution_role_arn,
    module.compute.api_task_role_arn,
    module.compute.worker_scheduler_role_arn,
    module.compute.worker_consumer_role_arn,
    module.compute.init_task_role_arn,
  ]
  tags = local.common_tags
}
