# The Control API answering with server errors. The data plane's alarms (../modules/monitoring) cover the tick, the bells
# and the database; the API is created here, so its alarm is too. Jobs keep running while the API is down, so this one is
# about operators losing sight, not about lost work. The target group's 5xx count is what the API itself answered: a 502
# or 503 from the load balancer (no healthy task) is a different metric and the target's health check covers it.

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  count = var.alert_api_errors ? 1 : 0

  alarm_name          = "${var.name}-control-api-errors"
  alarm_description   = "The Control API has answered with server errors for five minutes. Workers and the tick do not depend on it; operators and the panel do. Runbook: ${var.runbook_base_url}/control-api-errors.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.api_errors_per_minute
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = local.tags

  dimensions = {
    LoadBalancer = aws_lb.control.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
}
