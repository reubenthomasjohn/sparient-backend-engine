region      = "us-east-2"
name_prefix = "sparient-dev"

# Single S3 bucket (4 prefixes inside)
s3_bucket = "sparient-remediation-testing"

# Concurrency caps
discovery_max_concurrency   = 5
api_provisioned_concurrency = 0

# CI/CD
github_owner         = "reubenthomasjohn"
github_repo_name       = "sparient-backend-engine"
# github_deploy_branch = "main"
