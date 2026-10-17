# The Control API (`qcloud-api serve`). One image, the one every cloud runs, configured only by its environment:
# variables.tf is the source of every value, and docs/runbooks/deploy-aws.md has the table of what each one means.
#
# Timeouts, from the outside in:
#   load balancer idle timeout   alb_idle_timeout_seconds (60 s, at least twice the heartbeat). The load balancer
#                                has no limit on how long a request lasts, only on how long a connection is silent.
#   event stream lifetime        event_stream_lifetime_seconds (600 s): the API closes the stream, the client resumes
#                                with Last-Event-ID, so no stream is ever cut by anything in front of the API
#   server idle timeout          255 s, the most Bun allows (set in the image's code, not here)
#   heartbeat                    event_heartbeat_seconds (15 s): a comment line, so nothing in front sees an idle
#                                connection
# A stream holds one connection for its whole life: api_event_streams caps them per task.
#
# The count is fixed, not scaled: every task holds api_pool_size database connections, which the data plane's
# connection budget counts in advance. A rollover never runs more tasks than the count (maximum 100 %), and with two
# or more keeps half of them serving (minimum 50 %).

locals {
  fleet_env = var.fleet == null ? {} : merge(
    { QCLOUD_FLEET_WORKERS = tostring(var.fleet.workers) },
    var.fleet.pool_size == null ? {} : { QCLOUD_FLEET_POOL_SIZE = tostring(var.fleet.pool_size) },
    var.fleet.listeners == null ? {} : { QCLOUD_FLEET_LISTENERS = tostring(var.fleet.listeners) },
    var.fleet.control_processes == null ? {} : { QCLOUD_FLEET_CONTROL_PROCESSES = tostring(var.fleet.control_processes) },
    var.fleet.pooler_pool_size == null ? {} : { QCLOUD_FLEET_POOLER_POOL_SIZE = tostring(var.fleet.pooler_pool_size) },
  )

  api_env = merge(
    {
      QCLOUD_NAMESPACE          = var.namespace
      QCLOUD_TRANSPORT          = "aws-sqs"
      QCLOUD_AWS_REGION         = var.region
      QCLOUD_DATABASE_POOL_SIZE = tostring(var.api_pool_size)

      QCLOUD_API_OIDC_ISSUER   = var.oidc_issuer
      QCLOUD_API_OIDC_AUDIENCE = join(",", var.oidc_audience)
      QCLOUD_API_OIDC_JWKS_URL = var.oidc_jwks_url
      QCLOUD_API_CORS_ORIGINS  = join(",", concat([local.panel_url], var.extra_cors_origins))

      QCLOUD_API_EVENTS_HEARTBEAT_MS    = tostring(var.event_heartbeat_seconds * 1000)
      QCLOUD_API_EVENTS_MAX_LIFETIME_MS = tostring(var.event_stream_lifetime_seconds * 1000)
      QCLOUD_API_EVENTS_MAX_STREAMS     = tostring(var.api_event_streams)
      QCLOUD_API_SHUTDOWN_GRACE_MS      = tostring(var.shutdown_grace_seconds * 1000)
    },
    local.database_env,
    local.fleet_env,
    var.role_claim == null ? {} : { QCLOUD_API_ROLE_CLAIM = var.role_claim },
    var.operator_roles == null ? {} : { QCLOUD_API_OPERATOR_ROLES = join(",", var.operator_roles) },
    var.viewer_roles == null ? {} : { QCLOUD_API_VIEWER_ROLES = join(",", var.viewer_roles) },
  )

  # The database URL is a secret: ECS reads it with the execution role when the task starts and hands it over as an
  # environment variable. It never appears in the task definition's environment.
  api_secrets = { QCLOUD_DATABASE_URL = var.database_url_secret }

  api_container = {
    name         = "api"
    image        = var.api_image
    essential    = true
    command      = ["serve"]
    stopTimeout  = var.shutdown_grace_seconds + 10
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment  = [for key, value in local.api_env : { name = key, value = value }]
    secrets      = [for key, arn in local.api_secrets : { name = key, valueFrom = arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.log_groups.api
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = local.log_groups.api
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_task_definition" "api" {
  family                   = local.api_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.api_task.arn
  container_definitions    = jsonencode([local.api_container])
  tags                     = local.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.execution, aws_iam_role_policy.api_queues]
}

resource "aws_ecs_service" "api" {
  name                               = local.api_name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_instances
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = var.api_instances >= 2 ? 50 : 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 60
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
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener_rule.api, aws_vpc_security_group_ingress_rule.tasks_from_alb]
}
