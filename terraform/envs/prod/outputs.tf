output "api_endpoint" { value = module.api.api_endpoint }
output "discovery_queue_url" { value = module.queues.discovery_queue_url }
output "ecr_repo_urls" { value = module.ecr.repo_urls }
output "migrate_repo_url" { value = aws_ecr_repository.migrate.repository_url }
output "migrate_function_name" { value = aws_lambda_function.migrate.function_name }
output "github_actions_role_arn" { value = aws_iam_role.github_actions.arn }
output "course_workflow_arn" { value = aws_sfn_state_machine.course_workflow.arn }
output "db_proxy_endpoint" { value = module.database.proxy_endpoint }
