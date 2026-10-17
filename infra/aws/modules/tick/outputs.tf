output "family" {
  value = aws_ecs_task_definition.this.family
}

output "task_definition_arn_without_revision" {
  description = "The family's ARN with no revision: a schedule that uses it starts the latest active revision, so a new image reaches the tick without touching the schedule."
  value       = aws_ecs_task_definition.this.arn_without_revision
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "environment" {
  description = "The plain environment the container gets, for the plan check."
  value       = local.environment
}

output "secret_env_names" {
  value = sort(keys(var.secret_env))
}

output "pool_size" {
  value = var.pool_size
}

output "entry_point" {
  description = "The entrypoint override, or null for the image's own."
  value       = var.command
}

output "command" {
  description = "What the container runs after the entrypoint: one invocation of the tick."
  value       = ["run"]
}
