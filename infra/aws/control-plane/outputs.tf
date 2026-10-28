output "api_url" {
  description = "The Control API's base URL: what the panel is configured with."
  value       = local.api_url
}

output "panel_url" {
  description = "Where users open the panel."
  value       = local.panel_url
}

output "exposure" {
  value = var.exposure
}

output "alb_dns_name" {
  description = "Point api_hostname and panel_hostname at this (a CNAME, or an alias record in Route 53)."
  value       = aws_lb.control.dns_name
}

output "alb_zone_id" {
  description = "The load balancer's hosted zone, for a Route 53 alias record."
  value       = aws_lb.control.zone_id
}

output "api_task_role_arn" {
  description = "The API's task role. The data plane's `additional_principal_arns` must list this exact ARN, or every call to a queue is denied."
  value       = aws_iam_role.api_task.arn
}

output "role_arns" {
  value = {
    api_task          = aws_iam_role.api_task.arn
    api_execution     = aws_iam_role.execution["api"].arn
    panel_execution   = aws_iam_role.execution["panel"].arn
    migrate_execution = aws_iam_role.execution["migrate"].arn
    ingest_execution  = local.ingest ? aws_iam_role.execution["ingest"].arn : null
  }
}

output "ingest_url" {
  description = "Where senders post (a source's address is this plus /s/<token>). Null without an ingest. Point ingest.hostname at the load balancer (alb_dns_name) and have the certificate cover it."
  value       = local.ingest ? "https://${var.ingest.hostname}" : null
}

output "migrate" {
  description = "What `aws ecs run-task` needs to run the migration: cluster, task definition, subnets and security group."
  value = {
    cluster         = var.cluster_arn
    task_definition = aws_ecs_task_definition.migrate.family
    subnets         = var.private_subnet_ids
    security_groups = [var.tasks_security_group_id]
    log_group       = local.log_groups.migrate
  }
}

output "services" {
  value = {
    api    = aws_ecs_service.api.name
    panel  = aws_ecs_service.panel.name
    ingest = local.ingest ? aws_ecs_service.ingest[0].name : null
  }
}

output "event_stream" {
  description = "The numbers that keep a stream from being cut mid-event, for the runbook and the smoke test."
  value = {
    alb_idle_timeout_seconds = var.alb_idle_timeout_seconds
    lifetime_seconds         = var.event_stream_lifetime_seconds
    heartbeat_seconds        = var.event_heartbeat_seconds
    streams_per_task         = var.api_event_streams
    shutdown_grace_seconds   = var.shutdown_grace_seconds
  }
}

output "oidc_redirect_uris" {
  description = "Register these at the identity provider as the panel's redirect (and post-logout) URIs."
  value       = [local.panel_url, "${local.panel_url}/"]
}

output "connection_budget" {
  description = "What the control plane holds, against what the data plane counted."
  value = {
    api_connections        = local.api_max_instances * var.api_pool_size
    ingest_connections     = local.ingest ? local.ingest_max_instances * var.ingest.pool_size : 0
    budgeted_processes     = var.budgeted_control_processes
    budgeted_pool_per_each = var.budgeted_control_pool_size
  }
}

output "alarm_names" {
  description = "The control plane's alarms: alarm => name."
  value       = { for alarm in aws_cloudwatch_metric_alarm.api_errors : "api_errors" => alarm.alarm_name }
}
