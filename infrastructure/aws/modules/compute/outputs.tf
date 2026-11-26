output "ecr_server_repository_url" {
  value       = aws_ecr_repository.server.repository_url
  description = "ECR URL for the single unified nestly-server image"
}

output "ecr_server_repository_arn" {
  value       = aws_ecr_repository.server.arn
  description = "ECR ARN for nestly-server"
}

output "alb_arn" {
  value       = aws_lb.api.arn
  description = "Application Load Balancer ARN"
}

output "alb_arn_suffix" {
  value       = aws_lb.api.arn_suffix
  description = "ALB ARN suffix for CloudWatch alarms"
}

output "alb_dns_name" {
  value       = aws_lb.api.dns_name
  description = "Application Load Balancer DNS name"
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.main.name
  description = "ECS cluster name"
}

output "ecs_cluster_arn" {
  value       = aws_ecs_cluster.main.arn
  description = "ECS cluster ARN"
}

output "api_service_name" {
  value       = aws_ecs_service.api.name
  description = "ECS API service name"
}

output "worker_scheduler_service_name" {
  value       = aws_ecs_service.worker_scheduler.name
  description = "ECS worker scheduler service name"
}

output "worker_consumer_service_name" {
  value       = aws_ecs_service.worker_consumer.name
  description = "ECS worker consumer service name"
}

output "init_task_definition_family" {
  value       = aws_ecs_task_definition.init.family
  description = "One-off init/migrate task definition family"
}

output "init_task_definition_arn" {
  value       = aws_ecs_task_definition.init.arn
  description = "One-off init/migrate task definition ARN"
}

output "execution_role_arn" {
  value       = aws_iam_role.ecs_execution.arn
  description = "ECS task execution role ARN"
}

output "api_task_role_arn" {
  value       = aws_iam_role.api_task.arn
  description = "ECS API task role ARN"
}

output "worker_scheduler_role_arn" {
  value       = aws_iam_role.worker_scheduler_task.arn
  description = "ECS worker scheduler role ARN"
}

output "worker_consumer_role_arn" {
  value       = aws_iam_role.worker_consumer_task.arn
  description = "ECS worker consumer role ARN"
}

output "init_task_role_arn" {
  value       = aws_iam_role.init_task.arn
  description = "ECS init task role ARN"
}

output "secret_names" {
  value = {
    database_url           = aws_secretsmanager_secret.database_url.name
    redis_url              = aws_secretsmanager_secret.redis_url.name
    jwt_access_secret      = aws_secretsmanager_secret.jwt_access_secret.name
    payment_webhook_secret = aws_secretsmanager_secret.payment_webhook_secret.name
    origin_verify_header   = aws_secretsmanager_secret.origin_verify.name
  }
  description = "Secrets Manager secret container names"
}

# Exposed IAM policy JSON documents for terraform test & checkov inspection (Change #5)
output "ecs_execution_iam_policy_json" {
  value       = local.ecs_execution_policy_json
  description = "ECS task execution role IAM policy JSON"
}

output "api_task_iam_policy_json" {
  value       = local.api_task_policy_json
  description = "API task role IAM policy JSON"
}

output "worker_scheduler_iam_policy_json" {
  value       = local.worker_scheduler_policy_json
  description = "Worker scheduler task role IAM policy JSON"
}

output "worker_consumer_iam_policy_json" {
  value       = local.worker_consumer_policy_json
  description = "Worker consumer task role IAM policy JSON"
}

output "init_task_iam_policy_json" {
  value       = local.init_task_policy_json
  description = "Init task role IAM policy JSON"
}

output "hardening_audit" {
  value = {
    ecr_repository_name            = aws_ecr_repository.server.name
    ecr_image_tag_mutability       = aws_ecr_repository.server.image_tag_mutability
    ecr_scan_on_push               = aws_ecr_repository.server.image_scanning_configuration[0].scan_on_push
    alb_default_status_code        = one(aws_lb_listener.api.default_action).fixed_response[0].status_code
    alb_deregistration_delay       = tonumber(aws_lb_target_group.api.deregistration_delay)
    worker_scheduler_desired_count = aws_ecs_service.worker_scheduler.desired_count
    exec_command_disabled_all = (
      aws_ecs_service.api.enable_execute_command == false &&
      aws_ecs_service.worker_scheduler.enable_execute_command == false &&
      aws_ecs_service.worker_consumer.enable_execute_command == false
    )
    api_circuit_breaker_enable   = aws_ecs_service.api.deployment_circuit_breaker[0].enable
    api_circuit_breaker_rollback = aws_ecs_service.api.deployment_circuit_breaker[0].rollback
    api_stop_timeout             = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].stopTimeout
    api_readonly_root_fs         = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].readonlyRootFilesystem
    api_env_map = {
      for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.name => e.value
    }
  }
  description = "Non-sensitive compute & ALB hardening attributes for terraform test assertions"
}
