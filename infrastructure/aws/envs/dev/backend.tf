# Local state is active by default so offline validation and plans never touch AWS.
# Before running `terraform apply` against a real AWS account:
#   1. Create an encrypted, versioned, private S3 bucket for state (plus KMS key or SSE-S3).
#   2. Never commit `terraform.tfstate*` (it contains generated values like origin_verify_secret).
#   3. Uncomment the backend block below and run `terraform init -migrate-state`.
#
# terraform {
#   backend "s3" {
#     bucket       = "nestly-terraform-state-<account-id>"
#     key          = "dev/terraform.tfstate"
#     region       = "us-east-1"
#     encrypt      = true
#     use_lockfile = true
#   }
# }
