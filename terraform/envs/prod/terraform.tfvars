region      = "us-west-2"
name_prefix = "sparient-prod"

# Concurrency caps
discovery_max_concurrency   = 5
api_provisioned_concurrency = 1

# CI/CD
github_owner         = "reubenthomasjohn"
github_repo_name     = "sparient-backend-engine"
github_deploy_branch = "prod"
