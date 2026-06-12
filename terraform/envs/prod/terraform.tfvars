region      = "us-west-2"
name_prefix = "sparient-prod"

# Concurrency caps
discovery_max_concurrency = 5

# 0 until the account's Lambda concurrent-executions quota (10, the new-account floor in
# us-west-2) is raised — provisioned concurrency needs unreserved to stay >= 10. After the
# Service Quotas increase lands, set to 1 and `terraform apply`.
api_provisioned_concurrency = 0

# CI/CD
github_owner         = "reubenthomasjohn"
github_repo_name     = "sparient-backend-engine"
github_deploy_branch = "main"
