# The schema migration as a one-off ECS task (`qcloud-api migrate`), run by the release process before the services roll
# to a build that needs a newer schema, and never from a serving task: tasks that start together would race to migrate,
# which is the classic outage. The task holds one advisory lock for the migration (transaction-scoped, so a pooler is
# safe), exits 0 when the database is current and non-zero otherwise, and a new API task reports `schema: behind` from
# `/health/ready` until it has run. Migrations only add: an old task keeps serving against the newer schema while they
# roll.
#
# The task definition is the API's image with another command, so one build is both. There is no service and nothing
# listens: `aws ecs run-task` starts it (the `migrate` output has the whole command), and it costs the seconds it runs.
# It has no task role, because it calls no AWS API.

locals {
  migrate_env = merge(
    {
      QCLOUD_DATABASE_POOLER    = local.migrate_pooled ? "transaction" : "none"
      QCLOUD_DATABASE_POOL_SIZE = "1"
    },
    var.database_tls_env,
  )

  migrate_container = {
    name        = "migrate"
    image       = var.api_image
    essential   = true
    command     = ["migrate"]
    stopTimeout = 30
    environment = [for key, value in local.migrate_env : { name = key, value = value }]
    secrets     = [{ name = "QCLOUD_DATABASE_URL", valueFrom = local.migrate_url_secret }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.log_groups.migrate
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = local.log_groups.migrate
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.migrate_cpu)
  memory                   = tostring(var.migrate_memory)
  execution_role_arn       = aws_iam_role.execution["migrate"].arn
  container_definitions    = jsonencode([local.migrate_container])
  tags                     = local.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  depends_on = [aws_cloudwatch_log_group.migrate, aws_iam_role_policy.execution]
}
