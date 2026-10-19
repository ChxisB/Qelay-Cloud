# One worker service on ECS Fargate: tasks that run a Qelay Worker, pull bells from SQS and claim jobs from
# Postgres. A worker serves no port, so there is no load balancer. It sits in private subnets and takes no
# inbound connection (its security group has none).
#
# The service is capped by max_instances: it is the figure the connection budget counts, so the autoscaling
# target holds it, and a rollover is configured not to exceed it.

locals {
  environment = merge(var.env, { QCLOUD_DATABASE_POOL_SIZE = tostring(var.pool_size) })
  container = merge(
    {
      name        = "worker"
      image       = var.image
      essential   = true
      stopTimeout = var.stop_timeout_seconds
      environment = [for key, value in local.environment : { name = key, value = value }]
      secrets     = [for key, arn in var.secret_env : { name = key, valueFrom = arn }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    },
    var.command == null ? {} : { command = var.command },
    var.entry_point == null ? {} : { entryPoint = var.entry_point },
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

resource "aws_ecs_service" "this" {
  name                               = var.name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.min_instances
  launch_type                        = var.spot ? null : "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  force_new_deployment               = true
  tags                               = var.tags

  triggers = {
    rollout = var.rollout_trigger
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # The floor is on-demand and everything above it is Spot. Both providers must be on the cluster (the example's
  # aws_ecs_cluster_capacity_providers).
  dynamic "capacity_provider_strategy" {
    for_each = var.spot ? { FARGATE = [var.min_instances, 0], FARGATE_SPOT = [0, 1] } : {}
    content {
      capacity_provider = capacity_provider_strategy.key
      base              = capacity_provider_strategy.value[0]
      weight            = capacity_provider_strategy.value[1]
    }
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  lifecycle {
    # Autoscaling owns the count once it is on, and an operator's manual change should not be undone by an apply.
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  min_capacity       = var.min_instances
  max_capacity       = var.max_instances
}

resource "aws_appautoscaling_policy" "scale_out" {
  count = var.autoscaling == null ? 0 : 1

  name               = "${var.name}-scale-out"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = var.autoscaling.cooldown_seconds
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = var.autoscaling.scale_out_step
    }
  }
}

resource "aws_appautoscaling_policy" "scale_in" {
  count = var.autoscaling == null ? 0 : 1

  name               = "${var.name}-scale-in"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = var.autoscaling.cooldown_seconds
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -var.autoscaling.scale_in_step
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "scale_out" {
  count = var.autoscaling == null ? 0 : 1

  alarm_name          = "${var.name}-queue-deep"
  alarm_description   = "Bells are waiting in ${var.autoscaling.queue_name}: add workers (autoscaling, not a page)"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = var.autoscaling.queue_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = var.autoscaling.scale_out_above
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.scale_out[0].arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "scale_in" {
  count = var.autoscaling == null ? 0 : 1

  alarm_name          = "${var.name}-queue-shallow"
  alarm_description   = "${var.autoscaling.queue_name} is nearly empty: remove workers (autoscaling, not a page)"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = var.autoscaling.queue_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 10
  threshold           = var.autoscaling.scale_in_below
  comparison_operator = "LessThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.scale_in[0].arn]
  tags                = var.tags
}
