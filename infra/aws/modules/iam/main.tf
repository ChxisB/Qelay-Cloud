# Identities, least privilege. There is no wildcard action and no AWS-managed policy anywhere in this module, and
# a statement names its resources by ARN wherever the service lets it (the three that cannot are marked below).
#
#   workers task        receive, delete, change visibility and send on the environment's queues; read the dead-letter
#                       queues' depth; read queue metrics
#   workers execution   pull the image, write the log group, read the worker secrets (ECS does this at task start)
#   tick task           send on the queues (the tick only rings)
#   tick execution      the same as the workers' execution role, with the tick's secrets and log groups (the loop's and
#                       the sender's too: they run as the tick, with the webhook key the workers never read)
#   scheduler           run the tick task definition in the one cluster, and pass the tick's two roles to ECS
#
# The database is reached on its private address with a password, so no role holds an RDS permission. The queues'
# policies repeat the grants and deny everything else: see the queue policies below.
#
# The roles' ARNs are written from the account and the names, so every policy below is readable in a plan before
# anything exists. A resource that is created in the same apply (a log group, a queue) is named the same way.

locals {
  role_arn = { for role in ["workers-task", "workers-execution", "tick-task", "tick-execution", "scheduler"] : role => "arn:${var.partition}:iam::${var.account_id}:role/${var.name}-${role}" }
  ecs_arn  = "arn:${var.partition}:ecs:${var.region}:${var.account_id}"
  logs_arn = "arn:${var.partition}:logs:${var.region}:${var.account_id}:log-group"

  queue_arns       = values(var.queue_arns)
  dead_letter_arns = values(var.dead_letter_arns)
  tasks            = [local.role_arn["workers-task"], local.role_arn["tick-task"]]
  # Who the queue policies let past their deny: the two task roles, and whoever the deployer adds.
  admitted = concat(local.tasks, var.additional_principal_arns)

  # ARNs of Secrets Manager secrets end in a random "-" and six characters, which exist only once the secret does.
  secret_arns = {
    workers = [for name in values(var.worker_secret_names) : "arn:${var.partition}:secretsmanager:${var.region}:${var.account_id}:secret:${name}-??????"]
    tick    = [for name in values(var.tick_secret_names) : "arn:${var.partition}:secretsmanager:${var.region}:${var.account_id}:secret:${name}-??????"]
  }

  queue_key_actions = ["kms:GenerateDataKey", "kms:Decrypt"]
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    # Confused deputy: only ECS acting for this account may assume the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "workers_task" {
  name               = "${var.name}-workers-task"
  description        = "Qelay-Cloud workers: the queues, and nothing else"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role" "workers_execution" {
  name               = "${var.name}-workers-execution"
  description        = "Qelay-Cloud workers: ECS pulls the image, writes logs and reads the secrets for them"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role" "tick_task" {
  name               = "${var.name}-tick-task"
  description        = "Qelay-Cloud tick: rings the queues, and nothing else"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role" "tick_execution" {
  name               = "${var.name}-tick-execution"
  description        = "Qelay-Cloud tick: ECS pulls the image, writes logs and reads the secrets for it"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role" "scheduler" {
  name        = "${var.name}-scheduler"
  description = "Qelay-Cloud scheduler: runs the tick task and nothing else"
  tags        = var.tags
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.account_id
          "aws:SourceArn"     = "arn:${var.partition}:scheduler:${var.region}:${var.account_id}:schedule/default/${var.schedule_name}"
        }
      }
    }]
  })
}

# --- the tasks' roles -----------------------------------------------------------------------------------

resource "aws_iam_role_policy" "workers_queues" {
  name = "use-the-queues"
  role = aws_iam_role.workers_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ConsumeAndRing"
        Effect = "Allow"
        Action = [
          "sqs:GetQueueUrl",
          "sqs:GetQueueAttributes",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:SendMessage", # SendMessageBatch is authorised by this action
        ]
        Resource = local.queue_arns
      },
      {
        Sid      = "ReadDeadLetterDepth"
        Effect   = "Allow"
        Action   = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
        Resource = local.dead_letter_arns
      },
      {
        # The age of the oldest message is a CloudWatch metric, and CloudWatch metric reads take no resource.
        Sid      = "ReadQueueMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricData"]
        Resource = ["*"]
      },
    ]
  })
}

resource "aws_iam_role_policy" "tick_queues" {
  name = "ring-the-queues"
  role = aws_iam_role.tick_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "Ring"
      Effect   = "Allow"
      Action   = ["sqs:GetQueueUrl", "sqs:SendMessage"]
      Resource = local.queue_arns
    }]
  })
}

# Producers need both key actions, consumers Decrypt; one statement per role keeps them the same shape.
resource "aws_iam_role_policy" "workers_queue_key" {
  count = var.queue_key_enabled ? 1 : 0

  name = "use-the-queue-key"
  role = aws_iam_role.workers_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "QueueKey"
      Effect    = "Allow"
      Action    = local.queue_key_actions
      Resource  = [var.kms_key_arn]
      Condition = { StringEquals = { "kms:ViaService" = "sqs.${var.region}.amazonaws.com" } }
    }]
  })
}

resource "aws_iam_role_policy" "tick_queue_key" {
  count = var.queue_key_enabled ? 1 : 0

  name = "use-the-queue-key"
  role = aws_iam_role.tick_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "QueueKey"
      Effect    = "Allow"
      Action    = local.queue_key_actions
      Resource  = [var.kms_key_arn]
      Condition = { StringEquals = { "kms:ViaService" = "sqs.${var.region}.amazonaws.com" } }
    }]
  })
}

# --- the execution roles --------------------------------------------------------------------------------

resource "aws_iam_role_policy" "workers_execution" {
  name = "start-the-task"
  role = aws_iam_role.workers_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # ecr:GetAuthorizationToken is account-wide: the action takes no resource.
          Sid      = "RegistryLogin"
          Effect   = "Allow"
          Action   = ["ecr:GetAuthorizationToken"]
          Resource = ["*"]
        },
        {
          Sid      = "WriteLogs"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = [for group in var.workers_log_groups : "${local.logs_arn}:${group}:*"]
        },
        {
          Sid      = "ReadSecrets"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = local.secret_arns.workers
        },
      ],
      length(var.image_repository_arns) == 0 ? [] : [{
        Sid      = "PullImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = var.image_repository_arns
      }],
      var.secrets_kms_key_arn == null ? [] : [{
        Sid       = "DecryptSecrets"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = [var.secrets_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
      }],
    )
  })
}

resource "aws_iam_role_policy" "tick_execution" {
  name = "start-the-task"
  role = aws_iam_role.tick_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "RegistryLogin"
          Effect   = "Allow"
          Action   = ["ecr:GetAuthorizationToken"]
          Resource = ["*"]
        },
        {
          Sid      = "WriteLogs"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = [for group in concat([var.tick_log_group], var.tick_extra_log_groups) : "${local.logs_arn}:${group}:*"]
        },
        {
          Sid      = "ReadSecrets"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = local.secret_arns.tick
        },
      ],
      length(var.image_repository_arns) == 0 ? [] : [{
        Sid      = "PullImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = var.image_repository_arns
      }],
      var.secrets_kms_key_arn == null ? [] : [{
        Sid       = "DecryptSecrets"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = [var.secrets_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
      }],
    )
  })
}

# --- the scheduler's role -------------------------------------------------------------------------------

resource "aws_iam_role_policy" "scheduler" {
  name = "run-the-tick"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RunTheTick"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = ["${local.ecs_arn}:task-definition/${var.tick_family}:*"]
        Condition = {
          ArnEquals = { "ecs:cluster" = "${local.ecs_arn}:cluster/${var.cluster_name}" }
        }
      },
      {
        Sid      = "PassTheTicksRoles"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [local.role_arn["tick-task"], local.role_arn["tick-execution"]]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
    ]
  })
}

# --- the queues' own policies ---------------------------------------------------------------------------
#
# The identity policies above already grant the tasks what they need. A queue policy adds what an identity
# policy cannot: a refusal that holds whatever another policy in the account grants. Every queue refuses
# plaintext, and refuses the four message actions to anyone who is not one of the task roles or an additional
# principal. It leaves the management actions (create, tag, purge, delete) to the account's own policies, so
# Terraform and an operator can still manage the queue, and it does not name SQS's own dead-lettering, which
# is not a call by any principal.

resource "aws_sqs_queue_policy" "main" {
  for_each = var.queue_urls

  queue_url = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "WorkersConsumeAndRing"
        Effect    = "Allow"
        Principal = { AWS = [local.role_arn["workers-task"]] }
        Action    = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:SendMessage"]
        Resource  = var.queue_arns[each.key]
      },
      {
        Sid       = "TickRings"
        Effect    = "Allow"
        Principal = { AWS = [local.role_arn["tick-task"]] }
        Action    = ["sqs:GetQueueUrl", "sqs:SendMessage"]
        Resource  = var.queue_arns[each.key]
      },
      {
        Sid       = "NobodyElseTouchesMessages"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:SendMessage"]
        Resource  = var.queue_arns[each.key]
        Condition = { StringNotEquals = { "aws:PrincipalArn" = local.admitted } }
      },
      {
        Sid       = "EncryptedTransportOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = var.queue_arns[each.key]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_iam_role.workers_task, aws_iam_role.tick_task]
}

resource "aws_sqs_queue_policy" "dead_letter" {
  for_each = var.dead_letter_urls

  queue_url = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EncryptedTransportOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "sqs:*"
      Resource  = var.dead_letter_arns[each.key]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
