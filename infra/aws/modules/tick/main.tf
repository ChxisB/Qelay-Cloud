# The tick as a one-shot ECS task: `qcloud-tick run` does one invocation (repair, schedule, ring) and exits 0, 1 or 2.
# EventBridge Scheduler starts one every minute (../scheduler). Tasks may overlap when one runs long; the tick
# elects a leader by a lease row, so an overlap is safe, and the budget counts for it (control_processes).
#
# `serve` is not used: it answers a request authenticated by a Google identity token, which AWS cannot send.

locals {
  environment = merge(var.env, {
    QCLOUD_DATABASE_POOL_SIZE = tostring(var.pool_size)
    QCLOUD_TICK_MAX_RUN_MS    = tostring(var.max_run_ms)
  })
  container = merge(
    {
      name        = "tick"
      image       = var.image
      essential   = true
      command     = ["run"]
      stopTimeout = 30
      environment = [for key, value in local.environment : { name = key, value = value }]
      secrets     = [for key, arn in var.secret_env : { name = key, valueFrom = arn }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "tick"
        }
      }
    },
    var.command == null ? {} : { entryPoint = var.command },
  )
}

resource "aws_cloudwatch_log_group" "this" {
  name              = var.log_group_name
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn
  container_definitions    = jsonencode([local.container])
  tags                     = var.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  depends_on = [aws_cloudwatch_log_group.this]
}
