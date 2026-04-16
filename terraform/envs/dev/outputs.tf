output "api_endpoint"        { value = module.api.api_endpoint }
output "discovery_queue_url" { value = module.queues.discovery_queue_url }
output "ecr_repo_urls"       { value = module.ecr.repo_urls }
output "github_actions_role_arn" { value = aws_iam_role.github_actions.arn }
output "course_workflow_arn" { value = aws_sfn_state_machine.course_workflow.arn }

output "neon_connection_uri" {
  value     = neon_project.this.connection_uri
  sensitive = true
}
