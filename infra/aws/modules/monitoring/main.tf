# Alarms for what an operator must know: bells that dead-letter, bells nobody takes (and no worker at all), the
# database filling up or running out of connections, and a tick that has stopped. Every alarm's description ends with a
# link to its runbook under var.runbook_base_url (docs/runbooks). Where they notify is an input (alarm_actions);
# without actions an alarm still shows its state in CloudWatch, which is not the same as someone being told.
#
# Two alarms read metrics that exist only where you export them (claim latency, jobs failing for good): they are
# created only when you name the metric. Nothing here has fired on a real account; the thresholds are defaults.

locals {
  tick_metric_namespace = "Qelay/${var.name}"
  actions               = var.alarm_actions

  runbook = {
    for name in ["tick-stopped", "doorbells-piling-up", "transport-dead-letters", "connection-exhaustion", "database-storage-full", "slow-claims", "dead-letter-queue-growing"] :
    name => "Runbook: ${var.runbook_base_url}/${name}.md"
  }
}

# --- the doorbell -------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dead_letter_depth" {
  for_each = var.dead_letter_names

  alarm_name          = "${var.name}-${each.key}-dead-letter-depth"
  alarm_description   = "Bells reached the dead-letter queue ${each.value}. Each names a job still in Postgres, which the tick rings again; the depth is how often delivery failed. ${local.runbook["transport-dead-letters"]}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "dead_letter_age" {
  for_each = var.dead_letter_names

  alarm_name          = "${var.name}-${each.key}-dead-letter-age"
  alarm_description   = "The oldest bell in ${each.value} is older than ${var.dead_letter_age_seconds} s: nobody is looking at the dead-letter queue. ${local.runbook["transport-dead-letters"]}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.dead_letter_age_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = var.queue_names

  alarm_name          = "${var.name}-${each.key}-queue-age"
  alarm_description   = "The oldest bell in ${each.value} has waited more than ${var.queue_age_seconds} s: no worker is taking bells for this queue. ${local.runbook["doorbells-piling-up"]}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.queue_age_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  tags                = var.tags
}

# --- the database -------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "database_connections" {
  alarm_name          = "${var.name}-database-connections"
  alarm_description   = "Connections are above ${var.connection_alarm_ratio * 100}% of max_connections (${var.max_connections}): the budget in the README no longer holds, or something leaks. ${local.runbook["connection-exhaustion"]}"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { (var.database_dimension) = var.database_identifier }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = floor(var.max_connections * var.connection_alarm_ratio)
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "database_storage" {
  alarm_name          = "${var.name}-database-free-storage"
  alarm_description   = "Less than 10% of the ${var.database_storage_gb} GiB is free. Storage autoscaling (if on) is about to act; if it is off, grow the volume. ${local.runbook["database-storage-full"]}"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { (var.database_dimension) = var.database_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = floor(var.database_storage_gb * 1073741824 / 10)
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "database_cpu" {
  alarm_name          = "${var.name}-database-cpu"
  alarm_description   = "Database CPU has been above 80% for 15 minutes. ${local.runbook["slow-claims"]}"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { (var.database_dimension) = var.database_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.actions
  tags                = var.tags
}

# A burstable class runs in Unlimited mode: once its credits are gone it keeps bursting and RDS bills the surplus.
# A queue database is steady load, so a surplus balance above zero means the class is too small for it.
resource "aws_cloudwatch_metric_alarm" "database_cpu_credits" {
  count = var.database_instance_class != null && can(regex("^db\\.t", var.database_instance_class)) ? 1 : 0

  alarm_name          = "${var.name}-database-cpu-credits"
  alarm_description   = "The burstable database ${var.database_instance_class} has spent its CPU credits and is running on surplus credits, which are billed. Steady load needs a larger or a non-burstable class. ${local.runbook["slow-claims"]}"
  namespace           = "AWS/RDS"
  metric_name         = "CPUSurplusCreditBalance"
  dimensions          = { (var.database_dimension) = var.database_identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.actions
  tags                = var.tags
}

# --- the tick -----------------------------------------------------------------------------------------------
# The tick prints one JSON line per run with "ok": true when every pass ran and every bell was rung. The filter
# counts those lines, and the alarm fires when a window has none: a tick that fails, one that never starts, and
# a schedule that has been disabled all look the same, which is the point.

resource "aws_cloudwatch_log_metric_filter" "tick_succeeded" {
  name           = "${var.name}-tick-succeeded"
  log_group_name = var.tick_log_group_name
  pattern        = "{ $.ok = true }"

  metric_transformation {
    name          = "TickSucceeded"
    namespace     = local.tick_metric_namespace
    value         = "1"
    default_value = null
  }
}

resource "aws_cloudwatch_metric_alarm" "tick_stalled" {
  alarm_name          = "${var.name}-tick-stalled"
  alarm_description   = "No successful tick in ${var.tick_missed_minutes} minutes: delayed jobs, retries, crons and stalled-job recovery are not running unless a worker's in-process tick is. ${local.runbook["tick-stopped"]}"
  namespace           = local.tick_metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.tick_succeeded.metric_transformation[0].name
  statistic           = "Sum"
  period              = 60 * var.tick_schedule_minutes
  evaluation_periods  = ceil(var.tick_missed_minutes / var.tick_schedule_minutes)
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  tags                = var.tags
}

# --- no worker at all ---------------------------------------------------------------------------------------
# ECS reports a service's CPU only while it has a task, so a window with no datapoint is a service with nothing running.
# "Missing data" is the condition, hence breaching. The composite pairs it with a stale bell: a queue that is old AND every
# listed worker service empty. With several services this stays quiet while one of them runs, which the queue-age alarm
# of the queue it serves still catches.

resource "aws_cloudwatch_metric_alarm" "worker_absent" {
  for_each = toset(var.worker_service_names)

  alarm_name          = "${var.name}-${each.key}-no-tasks"
  alarm_description   = "The service ${each.key} has had no running task for 5 minutes. ${local.runbook["doorbells-piling-up"]}"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.key }
  statistic           = "SampleCount"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  tags                = var.tags
}

resource "aws_cloudwatch_composite_alarm" "workers_idle_with_backlog" {
  count = length(var.worker_service_names) > 0 && length(var.queue_names) > 0 ? 1 : 0

  alarm_name        = "${var.name}-workers-idle-with-backlog"
  alarm_description = "Bells are waiting and no worker task is running. Nothing is lost: the jobs are in Postgres. ${local.runbook["doorbells-piling-up"]}"
  alarm_rule = format(
    "(%s) AND (%s)",
    join(" OR ", [for alarm in aws_cloudwatch_metric_alarm.queue_age : "ALARM(\"${alarm.alarm_name}\")"]),
    join(" AND ", [for alarm in aws_cloudwatch_metric_alarm.worker_absent : "ALARM(\"${alarm.alarm_name}\")"])
  )
  alarm_actions = local.actions
  tags          = var.tags
}

# --- opt-in: metrics the application exports itself ---------------------------------------------------------
# Read only when you name the metric. The shipped tick image exports none, so these need your own OpenTelemetry
# pipeline into CloudWatch (docs/observability.md), and the names and units are whatever that pipeline gives them.

resource "aws_cloudwatch_metric_alarm" "claim_latency" {
  count = var.claim_latency_metric == null ? 0 : 1

  alarm_name          = "${var.name}-slow-claims"
  alarm_description   = "The 99th percentile of a claim is over ${var.claim_latency_p99_ms} ms. ${local.runbook["slow-claims"]}"
  namespace           = var.claim_latency_metric.namespace
  metric_name         = var.claim_latency_metric.name
  extended_statistic  = "p99"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.claim_latency_p99_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "dead_letter_queue_growth" {
  count = var.failed_total_metric == null ? 0 : 1

  alarm_name          = "${var.name}-jobs-failing-for-good"
  alarm_description   = "More than ${var.dlq_growth_per_window} jobs reached Qelay's dead-letter queue within ${var.dlq_growth_window_seconds} s. ${local.runbook["dead-letter-queue-growing"]}"
  evaluation_periods  = 2
  threshold           = var.dlq_growth_per_window
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  tags                = var.tags

  # The metric is a lifetime total, so the alarm reads its rate of change over the window, not its level.
  metric_query {
    id          = "total"
    return_data = false
    metric {
      namespace   = var.failed_total_metric.namespace
      metric_name = var.failed_total_metric.name
      period      = var.dlq_growth_window_seconds
      stat        = "Maximum"
    }
  }

  metric_query {
    id          = "grown"
    expression  = "RATE(total) * ${var.dlq_growth_window_seconds}"
    label       = "Jobs that reached the dead-letter queue in the window"
    return_data = true
  }
}
