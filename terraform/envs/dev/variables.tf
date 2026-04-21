variable "region" {
  type    = string
  default = "us-east-2"
}

variable "aws_profile" {
  type    = string
  default = "sparient"
}

# Set to false in CI (OIDC provides credentials, no profile needed).
variable "use_aws_profile" {
  type    = bool
  default = true
}

variable "name_prefix" {
  type    = string
  default = "sparient-dev"
}

# Neon API key — pass via TF_VAR_neon_api_key or GitHub Actions secret.
# NOT stored in tfvars.
variable "neon_api_key" {
  type      = string
  sensitive = true
}

# Single S3 bucket with 4 prefixes (connectivo-incoming/, connectivo-remediated/,
# sparient-remediation-requests/, sparient-remediation-responses/).
variable "s3_bucket" {
  type    = string
  default = "sparient-remediation-testing"
}

# Concurrency caps on the SQS event source mappings.
variable "discovery_max_concurrency" {
  type    = number
  default = 5
}

# Provisioned concurrency on the API Lambda (1 warm instance ≈ $5/mo at 1 GB).
variable "api_provisioned_concurrency" {
  type    = number
  default = 1
}

# GitHub Actions CI.
variable "github_owner" {
  type    = string
  default = "reubenthomasjohn"
}

variable "github_repo_name" {
  type = string
}

variable "github_deploy_branch" {
  type    = string
  default = "main"
}
