mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::nestly-dev-media-123456789012"
      bucket_regional_domain_name = "nestly-dev-media-123456789012.s3.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      id          = "EDFDVBD632BHDS5"
      arn         = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD632BHDS5"
      domain_name = "d111111abcdef8.cloudfront.net"
    }
  }

  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/nestly-mock-fn"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/nestly-dev-api-alb/1234567890"
      arn_suffix = "app/nestly-dev-api-alb/1234567890"
      dns_name   = "nestly-dev-api-alb-1234567890.us-east-1.elb.amazonaws.com"
    }
  }

  mock_resource "aws_lb_listener" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/nestly-dev-api-alb/1234567890/0987654321"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/nestly-dev-api-tg/1234567890"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/nestly-mock-role"
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/nestly/mock"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:nestly-dev-alerts"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:123456789012:nestly-mock-queue"
      url = "https://sqs.us-east-1.amazonaws.com/123456789012/nestly-mock-queue"
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:123456789012:repository/nestly-dev-nestly-server"
      repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/nestly-dev-nestly-server"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:123456789012:cluster/nestly-dev-cluster"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/nestly-dev-init:1"
    }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:nestly-mock-secret"
    }
  }

  mock_resource "aws_wafv2_web_acl" {
    defaults = {
      arn = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/nestly-dev-cloudfront-waf/1234"
    }
  }

  mock_resource "aws_opensearch_domain" {
    defaults = {
      arn      = "arn:aws:es:us-east-1:123456789012:domain/nestly-dev-search"
      endpoint = "vpc-nestly-dev-search-mock.us-east-1.es.amazonaws.com"
    }
  }
}

mock_provider "random" {
  mock_resource "random_password" {
    defaults = {
      result = "MockOriginVerifySecretHeaderValueForOfflineTests1234"
    }
  }
}

variables {
  project_name                  = "nestly"
  environment                   = "dev"
  aws_region                    = "us-east-1"
  aws_account_id                = "123456789012"
  azs                           = ["us-east-1a", "us-east-1b"]
  enable_opensearch             = false
  enable_waf                    = false
  enable_mock_payment_provider  = false
  deletion_protection           = true
  api_desired_count             = 2
  worker_consumer_desired_count = 1
}

run "verify_core_architecture_and_security" {
  command = apply

  # 1. Data tier: RDS private, encrypted, protected, PITR, AWS-managed password; Redis encrypted at rest & transit
  assert {
    condition     = output.audit_summary_for_test.data.rds_publicly_accessible == false
    error_message = "RDS PostgreSQL must never be publicly accessible."
  }

  assert {
    condition     = output.audit_summary_for_test.data.rds_storage_encrypted == true
    error_message = "RDS PostgreSQL storage encryption must be enabled."
  }

  assert {
    condition     = output.audit_summary_for_test.data.rds_deletion_protection == true
    error_message = "RDS deletion_protection must be enabled by default."
  }

  assert {
    condition     = output.audit_summary_for_test.data.rds_backup_retention_period >= 7
    error_message = "RDS automated PITR backup retention must be at least 7 days."
  }

  assert {
    condition     = output.audit_summary_for_test.data.rds_manage_master_user_password == true
    error_message = "RDS must manage master user password via Secrets Manager instead of Terraform state."
  }

  assert {
    condition = (
      tobool(output.audit_summary_for_test.data.redis_at_rest_encrypted) == true &&
      tobool(output.audit_summary_for_test.data.redis_transit_encrypted) == true
    )
    error_message = "ElastiCache Redis must enforce both at-rest and in-transit encryption."
  }

  # 2. Private S3 buckets (all 4 public access block flags true on BOTH media and client buckets)
  assert {
    condition = (
      output.audit_summary_for_test.storage_cdn.media_public_access.block_public_acls == true &&
      output.audit_summary_for_test.storage_cdn.media_public_access.block_public_policy == true &&
      output.audit_summary_for_test.storage_cdn.media_public_access.ignore_public_acls == true &&
      output.audit_summary_for_test.storage_cdn.media_public_access.restrict_public_buckets == true
    )
    error_message = "Media S3 bucket must set all 4 public access block flags to true."
  }

  assert {
    condition = (
      output.audit_summary_for_test.storage_cdn.client_public_access.block_public_acls == true &&
      output.audit_summary_for_test.storage_cdn.client_public_access.block_public_policy == true &&
      output.audit_summary_for_test.storage_cdn.client_public_access.ignore_public_acls == true &&
      output.audit_summary_for_test.storage_cdn.client_public_access.restrict_public_buckets == true
    )
    error_message = "Client SPA S3 bucket must set all 4 public access block flags to true."
  }

  # 3. SQS redrive maxReceiveCount == 5 and encrypted SSE on all 4 queues
  assert {
    condition = (
      output.audit_summary_for_test.messaging.main_queue_count == 4 &&
      output.audit_summary_for_test.messaging.dlq_count == 4
    )
    error_message = "Expected 4 primary SQS queues and 4 DLQs."
  }

  assert {
    condition = alltrue([
      for q in values(output.audit_summary_for_test.messaging.queues) :
      q.max_receive_count == 5 && q.sse_enabled == true
    ])
    error_message = "Every SQS queue must configure maxReceiveCount=5 and SSE."
  }

  # 4. Media CloudFront exposes properties/* ONLY (never uploads/*)
  assert {
    condition     = output.audit_summary_for_test.storage_cdn.media_ordered_path_patterns == ["properties/*"]
    error_message = "Media CloudFront must expose only properties/* via ordered cache behavior."
  }

  assert {
    condition = anytrue([
      for stmt in jsondecode(output.policy_documents_for_test.media_bucket).Statement :
      stmt.Effect != "Allow" ? false : endswith(stmt.Resource, "/properties/*")
    ])
    error_message = "Media bucket policy must allow CloudFront read access strictly on /properties/*."
  }

  # 5. Client + /api/* CloudFront (Changes #4, #12) and ALB origin verify (Change #1)
  assert {
    condition = (
      contains(output.api_forwarded_headers_for_test, "Authorization") &&
      contains(output.api_forwarded_headers_for_test, "Idempotency-Key") &&
      contains(output.api_forwarded_headers_for_test, "X-Request-Id")
    )
    error_message = "CloudFront /api/* origin request policy must forward Authorization, Idempotency-Key, and X-Request-Id."
  }

  assert {
    condition = (
      output.audit_summary_for_test.storage_cdn.client_api_behavior.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" &&
      contains(output.audit_summary_for_test.storage_cdn.client_api_behavior.allowed_methods, "POST") &&
      contains(output.audit_summary_for_test.storage_cdn.client_api_behavior.allowed_methods, "PUT") &&
      contains(output.audit_summary_for_test.storage_cdn.client_api_behavior.allowed_methods, "DELETE")
    )
    error_message = "CloudFront /api/* behavior must disable caching and allow all mutation HTTP methods."
  }

  assert {
    condition     = contains(output.audit_summary_for_test.storage_cdn.client_alb_custom_header_names, "X-Origin-Verify")
    error_message = "CloudFront ALB origin must inject the X-Origin-Verify header."
  }

  assert {
    condition     = output.audit_summary_for_test.compute.alb_default_status_code == "403"
    error_message = "ALB default listener action must reject requests lacking X-Origin-Verify with HTTP 403."
  }

  # 6. Compute hardening, Change #4 (no client ECR), & Change #11
  assert {
    condition     = strcontains(output.audit_summary_for_test.compute.ecr_repository_name, "nestly-server") && output.audit_summary_for_test.compute.ecr_image_tag_mutability == "IMMUTABLE" && output.audit_summary_for_test.compute.ecr_scan_on_push == true
    error_message = "Unified nestly-server ECR repository must enforce immutable tags and image scanning."
  }

  assert {
    condition     = output.audit_summary_for_test.compute.worker_scheduler_desired_count == 1
    error_message = "worker-scheduler ECS service must keep desired_count == 1."
  }

  assert {
    condition     = output.audit_summary_for_test.compute.exec_command_disabled_all == true
    error_message = "ECS Exec must remain disabled on all ECS services."
  }

  assert {
    condition = (
      output.audit_summary_for_test.compute.api_circuit_breaker_enable == true &&
      output.audit_summary_for_test.compute.api_circuit_breaker_rollback == true &&
      output.audit_summary_for_test.compute.alb_deregistration_delay == 30
    )
    error_message = "ALB deregistration_delay must be 30s and ECS deployment circuit breaker + rollback must be enabled."
  }

  assert {
    condition = (
      output.audit_summary_for_test.compute.api_stop_timeout == 30 &&
      output.audit_summary_for_test.compute.api_readonly_root_fs == true &&
      output.audit_summary_for_test.compute.api_env_map["DB_SSL"] == "true" &&
      output.audit_summary_for_test.compute.api_env_map["DB_SSL_CA_PATH"] == "/etc/ssl/certs/aws-rds-global-bundle.pem" &&
      output.audit_summary_for_test.compute.api_env_map["TRUST_PROXY"] == "2" &&
      output.audit_summary_for_test.compute.api_env_map["INIT_TARGET"] == "aws"
    )
    error_message = "API task definition must configure stopTimeout=30, readonlyRootFilesystem=true, DB_SSL=true, DB_SSL_CA_PATH, TRUST_PROXY=2, and INIT_TARGET=aws."
  }

  # 7. Exposed IAM jsonencode policies inspection (Changes #3, #5, #9, #10)
  assert {
    condition = (
      !strcontains(output.policy_documents_for_test.api_task, "sqs:CreateQueue") &&
      !strcontains(output.policy_documents_for_test.api_task, "s3:CreateBucket") &&
      !strcontains(output.policy_documents_for_test.worker_scheduler, "sqs:CreateQueue") &&
      !strcontains(output.policy_documents_for_test.worker_consumer, "sqs:CreateQueue") &&
      !strcontains(output.policy_documents_for_test.init_task, "sqs:CreateQueue") &&
      !strcontains(output.policy_documents_for_test.init_task, "s3:CreateBucket")
    )
    error_message = "No ECS task IAM role may grant CreateQueue or CreateBucket."
  }

  assert {
    condition = alltrue([
      for stmt in jsondecode(output.policy_documents_for_test.worker_consumer).Statement :
      stmt.Sid != "AllowSqsQueueAndDlqOperations" ? true : alltrue([
        for act in stmt.Action : contains(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:SendMessage"], act)
      ])
    ])
    error_message = "SQS IAM actions must be strictly scoped to the 5 runtime operations on exact queues and DLQs."
  }

  assert {
    condition = alltrue([
      for stmt in jsondecode(output.policy_documents_for_test.api_task).Statement :
      stmt.Sid != "AllowMediaObjectAccess" ? true : (
        alltrue([for act in stmt.Action : contains(["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], act)]) &&
        alltrue([for res in stmt.Resource : endswith(res, "/uploads/pending/*") || endswith(res, "/properties/*")])
      )
    ])
    error_message = "API task S3 object permissions must target only uploads/pending/* and properties/*."
  }

  assert {
    condition     = jsondecode(output.policy_documents_for_test.github_trust).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:AdityaXwhiz/Nestly:environment:production"
    error_message = "GitHub OIDC trust policy must pin strictly to AdityaXwhiz/Nestly and production environment."
  }
}

run "verify_optional_opensearch_and_waf" {
  command = apply

  variables {
    enable_opensearch = true
    enable_waf        = true
  }

  assert {
    condition     = output.audit_summary_for_test.data.opensearch_count == 1 && output.audit_summary_for_test.edge_waf == true
    error_message = "Optional OpenSearch domain and WAFv2 WebACL must provision when enabled."
  }

  assert {
    condition     = strcontains(output.policy_documents_for_test.init_task, "es:ESHttpPut")
    error_message = "Init task policy should permit OpenSearch alias creation ONLY when OpenSearch is enabled."
  }
}
