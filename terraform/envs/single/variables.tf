variable "region" {
  type    = string
  default = "us-east-2"
}

variable "aws_profile" {
  type    = string
  default = "sparient"
}

variable "name_prefix" {
  type    = string
  default = "sparient-single"
}

# Neon (https://neon.tech). Create an API key under Account settings → API keys.
# NOT stored in tfvars — pass via env: `export TF_VAR_neon_api_key=napi_...`
# (In CI: pull from GitHub Actions secret NEON_API_KEY and export the same env var.)
variable "neon_api_key" {
  type      = string
  sensitive = true
}

variable "neon_region" {
  type    = string
  default = "aws-us-east-2" # same region as the Lambda to avoid cross-region latency
}

variable "s3_source_bucket"     { type = string }
variable "s3_remediated_bucket" { type = string }

# Owner + repo name are kept as separate vars so the owner can default while the
# repo name must be supplied. Combined into `owner/repo` for the OIDC trust policy.
variable "github_owner" {
  type    = string
  default = "reubenthomasjohn"
}

variable "github_repo_name" {
  type = string
}

variable "github_deploy_branch" {
  type    = string
  default = "slim/repo"
}

variable "memory_mb" {
  type    = number
  default = 1024
}

variable "timeout_seconds" {
  type    = number
  default = 900
}
