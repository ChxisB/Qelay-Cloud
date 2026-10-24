# The inbound listener (`packages/ingest`): the public address a sender posts to, `/s/<token>`. Opt-in: see `ingest` in
# variables.tf. It validates, stores and answers; it never calls a destination, publishes to no queue and holds no job
# state, so it needs the database and nothing else (iam.tf: an execution role that reads two secrets, no task role).
#
# It is a separate service from the API on purpose (D12). The API is for signed-in operators and carries the event
# streams; this one is open to the internet and takes one small request at a time. It shares the load balancer and
# answers on a host name of its own, and the load balancer forwards only `/s/*` to it (alb.tf). Its own limits (body
# size, a rate per source and a global one) are per process; the per-address limit is the WAF's (waf.tf).

locals {
  ingest_name = "${var.name}-ingest"

  ingest_env = local.ingest ? merge(
    {
      QCLOUD_NAMESPACE                = var.namespace
      QCLOUD_DATABASE_POOL_SIZE       = tostring(var.ingest.pool_size)
      QCLOUD_INGEST_HOST              = "0.0.0.0"
      QCLOUD_INGEST_PORT              = "8081"
      QCLOUD_INGEST_SHUTDOWN_GRACE_MS = tostring(var.shutdown_grace_seconds * 1000)
    },
    local.database_env,
  ) : {}

  ingest_container = local.ingest ? {
    name         = "ingest"
    image        = var.ingest.image
    essential    = true
    stopTimeout  = var.shutdown_grace_seconds + 10
    portMappings = [{ containerPort = 8081, protocol = "tcp" }]
    environment  = [for key, value in local.ingest_env : { name = key, value = value }]
    secrets      = [for key, arn in local.api_secrets : { name = key, valueFrom = arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.log_groups.ingest
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "ingest"
      }
    }
  } : null
}

resource "aws_cloudwatch_log_group" "ingest" {
  count = local.ingest ? 1 : 0

  name              = local.log_groups.ingest
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_task_definition" "ingest" {
  count = local.ingest ? 1 : 0

  family                   = local.ingest_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.ingest.cpu)
  memory                   = tostring(var.ingest.memory)
  execution_role_arn       = aws_iam_role.execution["ingest"].arn
  container_definitions    = jsonencode([local.ingest_container])
  tags                     = local.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  depends_on = [aws_cloudwatch_log_group.ingest, aws_iam_role_policy.execution]
}

resource "aws_ecs_service" "ingest" {
  count = local.ingest ? 1 : 0

  name                               = local.ingest_name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.ingest[0].arn
  desired_count                      = var.ingest.instances
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = var.ingest.instances >= 2 ? 50 : 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 30
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  force_new_deployment               = true
  tags                               = local.tags

  # A task reads its secrets once, at start: a changed database secret must roll the service to reach them.
  triggers = {
    rollout = var.rollout_trigger
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tasks_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ingest[0].arn
    container_name   = "ingest"
    container_port   = 8081
  }

  depends_on = [aws_lb_listener_rule.ingest, aws_vpc_security_group_ingress_rule.tasks_from_alb_ingest]
}
