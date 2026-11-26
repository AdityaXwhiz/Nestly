output "vpc_id" {
  value       = aws_vpc.this.id
  description = "ID of the Nestly VPC"
}

output "vpc_cidr" {
  value       = aws_vpc.this.cidr_block
  description = "CIDR block of the Nestly VPC"
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "Public subnet IDs (ALB, NAT gateways)"
}

output "private_app_subnet_ids" {
  value       = aws_subnet.private_app[*].id
  description = "Private application subnet IDs (ECS tasks, interface VPC endpoints)"
}

output "private_data_subnet_ids" {
  value       = aws_subnet.private_data[*].id
  description = "Isolated private data subnet IDs (RDS, ElastiCache, OpenSearch)"
}

output "alb_sg_id" {
  value       = aws_security_group.alb.id
  description = "Security group ID for the Application Load Balancer"
}

output "api_sg_id" {
  value       = aws_security_group.api.id
  description = "Security group ID for API ECS tasks"
}

output "worker_sg_id" {
  value       = aws_security_group.worker.id
  description = "Security group ID for worker and init ECS tasks"
}

output "data_sg_id" {
  value       = aws_security_group.data.id
  description = "Security group ID for private data stores"
}

output "flow_logs_iam_policy_json" {
  value       = local.flow_logs_policy
  description = "IAM policy JSON for VPC Flow Logs (exposed for terraform test and policy inspection)"
}
