output "github_oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.github.arn
  description = "GitHub Actions OIDC identity provider ARN"
}

output "github_deploy_role_arn" {
  value       = aws_iam_role.github_deploy.arn
  description = "IAM role ARN assumed by deploy.yml via GitHub OIDC"
}

output "github_deploy_trust_policy_json" {
  value       = local.github_deploy_trust_policy_json
  description = "OIDC trust policy JSON exposed for terraform test"
}

output "github_deploy_iam_policy_json" {
  value       = local.github_deploy_iam_policy_json
  description = "GitHub deploy IAM permissions policy JSON exposed for terraform test"
}
