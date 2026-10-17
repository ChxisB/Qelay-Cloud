# EventBridge Scheduler starts the tick task every minute. Scheduler is the one scheduler of the three (it does not
# need a rule, a bus, or a Lambda): its target is the ECS RunTask API, called with the scheduler role.

resource "aws_scheduler_schedule" "tick" {
  name                         = var.name
  description                  = "Starts one Qelay tick (qcloud-tick run) in the private subnets"
  group_name                   = "default"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = "UTC"
  state                        = var.enabled ? "ENABLED" : "DISABLED"

  # A tick that cannot start now is of no use a minute later: the next one is already due.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.cluster_arn
    role_arn = var.role_arn

    ecs_parameters {
      task_definition_arn     = var.task_definition_arn
      launch_type             = "FARGATE"
      platform_version        = "LATEST"
      task_count              = 1
      enable_ecs_managed_tags = false # tagging at launch would need ecs:TagResource on the scheduler role, which it does not hold
      enable_execute_command  = false

      network_configuration {
        assign_public_ip = false
        subnets          = var.subnet_ids
        security_groups  = var.security_group_ids
      }
    }

    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 60
    }
  }
}
