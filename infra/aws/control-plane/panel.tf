# The panel (`server.js`, the static build). It holds no database connection, no secret and no AWS credential (the task
# has no role): the page and a `/config.json` built from the environment at start, which names the API and the identity
# provider and holds nothing a visitor could not read in the page anyway. The same build runs against a GCP Control API
# and an AWS one: only these values differ.

locals {
  panel_env = merge(
    {
      QCLOUD_PANEL_API_BASE_URL = local.api_url
      QCLOUD_PANEL_AUTH_MODE    = "oidc"
      # The authority and the client id are public by nature (the browser sends users to the first and names itself
      # with the second). A client secret would be refused by the panel at start.
      QCLOUD_PANEL_OIDC_AUTHORITY = local.oidc_authority
      QCLOUD_PANEL_OIDC_CLIENT_ID = var.oidc_client_id
    },
    var.oidc_scope == null ? {} : { QCLOUD_PANEL_OIDC_SCOPE = var.oidc_scope },
    var.oidc_token_audience == null ? {} : { QCLOUD_PANEL_OIDC_AUDIENCE = var.oidc_token_audience },
    length(var.panel_csp_connect_extra) == 0 ? {} : { QCLOUD_PANEL_CSP_CONNECT_EXTRA = join(" ", var.panel_csp_connect_extra) },
  )

  panel_container = {
    name         = "panel"
    image        = var.panel_image
    essential    = true
    stopTimeout  = 10
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment  = [for key, value in local.panel_env : { name = key, value = value }]
    secrets      = []
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.log_groups.panel
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "panel"
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "panel" {
  name              = local.log_groups.panel
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_task_definition" "panel" {
  family                   = local.panel_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.panel_cpu)
  memory                   = tostring(var.panel_memory)
  execution_role_arn       = aws_iam_role.execution["panel"].arn
  container_definitions    = jsonencode([local.panel_container])
  tags                     = local.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  depends_on = [aws_cloudwatch_log_group.panel, aws_iam_role_policy.execution]
}

resource "aws_ecs_service" "panel" {
  name                               = local.panel_name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.panel.arn
  desired_count                      = var.panel_instances
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = var.panel_instances >= 2 ? 50 : 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 30
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  force_new_deployment               = true
  tags                               = local.tags

  # The panel's configuration is in its environment, read at start: a changed value must roll it.
  triggers = {
    rollout = sha256(jsonencode(local.panel_env))
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
    target_group_arn = aws_lb_target_group.panel.arn
    container_name   = "panel"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener_rule.panel, aws_vpc_security_group_ingress_rule.tasks_from_alb]
}
