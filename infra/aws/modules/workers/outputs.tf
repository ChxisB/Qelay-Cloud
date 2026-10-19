output "service_name" {
  value = aws_ecs_service.this.name
}

output "task_definition_family" {
  value = aws_ecs_task_definition.this.family
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "environment" {
  description = "The plain environment the container gets, for the plan check (the task definition's JSON holds secret ARNs, which a plan does not know)."
  value       = local.environment
}

output "secret_env_names" {
  description = "The variables the container gets from Secrets Manager."
  value       = sort(keys(var.secret_env))
}

output "max_instances" {
  value = var.max_instances
}

output "pool_size" {
  value = var.pool_size
}

output "entry_point" {
  description = "The container's entry point override, for the plan check."
  value       = var.entry_point
}

output "command" {
  description = "The container's command override, for the plan check."
  value       = var.command
}
