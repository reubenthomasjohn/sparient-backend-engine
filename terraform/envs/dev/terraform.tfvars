region      = "us-east-2"
name_prefix = "sparient-dev"

# Existing buckets from .env
s3_source_bucket     = "connectivo-incoming"
s3_remediated_bucket = "connectivo-remediated"

# Concurrency caps
discovery_max_concurrency   = 5
upload_max_concurrency      = 10
api_provisioned_concurrency = 0

# CI/CD
github_owner         = "reubenthomasjohn"
github_repo_name       = "sparient-backend-engine"
# github_deploy_branch = "main"
