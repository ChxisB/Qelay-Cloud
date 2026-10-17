output "alarm_arns" {
  description = "Every alarm's ARN, by alarm name, for routing."
  value = merge(
    { for key, alarm in aws_cloudwatch_metric_alarm.dead_letter_depth : alarm.alarm_name => alarm.arn },
    { for key, alarm in aws_cloudwatch_metric_alarm.dead_letter_age : alarm.alarm_name => alarm.arn },
    { for key, alarm in aws_cloudwatch_metric_alarm.queue_age : alarm.alarm_name => alarm.arn },
    {
      (aws_cloudwatch_metric_alarm.database_connections.alarm_name) = aws_cloudwatch_metric_alarm.database_connections.arn
      (aws_cloudwatch_metric_alarm.database_storage.alarm_name)     = aws_cloudwatch_metric_alarm.database_storage.arn
      (aws_cloudwatch_metric_alarm.database_cpu.alarm_name)         = aws_cloudwatch_metric_alarm.database_cpu.arn
      (aws_cloudwatch_metric_alarm.tick_stalled.alarm_name)         = aws_cloudwatch_metric_alarm.tick_stalled.arn
    },
    { for key, alarm in aws_cloudwatch_composite_alarm.workers_idle_with_backlog : alarm.alarm_name => alarm.arn },
    { for key, alarm in aws_cloudwatch_metric_alarm.claim_latency : alarm.alarm_name => alarm.arn },
    { for key, alarm in aws_cloudwatch_metric_alarm.dead_letter_queue_growth : alarm.alarm_name => alarm.arn },
  )
}

output "tick_metric_namespace" {
  value = local.tick_metric_namespace
}
