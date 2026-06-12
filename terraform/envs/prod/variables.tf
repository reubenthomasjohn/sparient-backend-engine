variable "region" {
  type    = string
  default = "us-west-2"
}

variable "azs" {
  type    = list(string)
  default = ["us-west-2a", "us-west-2b"]
}

variable "aws_profile" {
  type    = string
  default = "sparient" # same account as dev — the existing profile deploys both envs
}

# Set to false in CI (OIDC provides credentials, no profile needed).
variable "use_aws_profile" {
  type    = bool
  default = true
}

variable "name_prefix" {
  type    = string
  default = "sparient-prod"
}

# SSM bastion for reaching the private RDS Proxy from a local DB client. On by default
# (~$3/mo for a t4g.nano). Set to false + apply to remove it when you don't need a tunnel.
variable "create_bastion" {
  type    = bool
  default = true
}

# --- RDS sizing / durability (prod-grade by default) ---
variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_backup_retention_period" {
  type    = number
  default = 7
}

# S3 buckets are per-institution (sparient-<institutionId>), created dynamically by
# InstitutionBucketService. No global bucket variable — IAM uses sparient-* wildcard.

# Concurrency caps on the SQS event source mappings.
variable "discovery_max_concurrency" {
  type    = number
  default = 5
}

# Writeback concurrency is capped low because Canvas rate-limits file uploads
# aggressively. Tune up after observing Canvas 429s in CloudWatch.
variable "writeback_max_concurrency" {
  type    = number
  default = 3
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
