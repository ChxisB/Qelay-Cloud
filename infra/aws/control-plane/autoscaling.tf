# Autoscaling for the two services that take load from outside: the API and, when there is one, the ingest. Target
# tracking on average CPU, between the minimum (api_instances, ingest.instances) and the maximum (api_max_instances,
# ingest.max_instances). The maximum defaults to the minimum, so nothing moves until you raise it; the target and the
# policy exist either way, and then change the count only if the bounds differ. The panel holds no connection and serves
# static files, so it stays at panel_instances.
#
# The registration needs the service-linked role AWSServiceRoleForApplicationAutoScaling_ECSService, which AWS creates
# the first time (the principal that applies needs iam:CreateServiceLinkedRole once). The data plane's worker services
# use the same service.
#
# Each API task holds api_pool_size database connections, so the maximum is what the data plane's connection budget has
# to count (main.tf checks it). CPU is the signal because it needs no metric of ours; for the ingest it follows request
# volume closely, since a post is parsed, checked and stored on the task. Scale-in waits 300 s: an event stream on a
# removed API task is closed with the task's shutdown grace and its client resumes on another with Last-Event-ID.

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${local.cluster_name}/${aws_ecs_service.api.name}"
  min_capacity       = var.api_instances
  max_capacity       = local.api_max_instances
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.api_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  resource_id        = aws_appautoscaling_target.api.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target_percent
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_target" "ingest" {
  count = local.ingest ? 1 : 0

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${local.cluster_name}/${aws_ecs_service.ingest[0].name}"
  min_capacity       = var.ingest.instances
  max_capacity       = local.ingest_max_instances
}

resource "aws_appautoscaling_policy" "ingest_cpu" {
  count = local.ingest ? 1 : 0

  name               = "${local.ingest_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.ingest[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.ingest[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.ingest[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target_percent
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
