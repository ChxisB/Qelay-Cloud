output "name" {
  value = aws_scheduler_schedule.tick.name
}

output "arn" {
  value = aws_scheduler_schedule.tick.arn
}

output "schedule_expression" {
  value = aws_scheduler_schedule.tick.schedule_expression
}
