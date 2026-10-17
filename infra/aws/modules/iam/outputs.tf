output "workers_task_role_arn" {
  value = aws_iam_role.workers_task.arn
}

output "workers_execution_role_arn" {
  value = aws_iam_role.workers_execution.arn
}

output "tick_task_role_arn" {
  value = aws_iam_role.tick_task.arn
}

output "tick_execution_role_arn" {
  value = aws_iam_role.tick_execution.arn
}

output "scheduler_role_arn" {
  value = aws_iam_role.scheduler.arn
}
