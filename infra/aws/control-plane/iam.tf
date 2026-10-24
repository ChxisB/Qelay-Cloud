# Identities, least privilege. No wildcard action and no AWS-managed policy; a statement names its resources by ARN
# wherever the service lets it (the two that cannot are marked).
#
#   api task          send on the doorbell queues (adding, retrying or promoting a job rings a bell) and read their
#                     depth; peek at the dead-letter queues (receive, never delete) and read their depth; read the age
#                     of the oldest message from CloudWatch; use the queue key through SQS
#   api execution     pull the image, write the API's log group, read the database secret (ECS does this at task start)
#   panel execution   pull the image and write the panel's log group. The panel has no task role: it serves static
#                     files and a config document, and holds no AWS credential at all
#   migrate execution pull the image, write the migration's log group, read the direct database secret
#                     (and no task role, for the same reason)
#   ingest execution  (only with `ingest`) pull the image, write the ingest's log group, read the database URL and the
#                     webhook key. No task role either: the ingest stores what it is sent in the database and reaches
#                     no queue and no other AWS service, so it holds no AWS credential at all
#
# The database is reached on its private address with a password, so no role holds an RDS permission. The data
# plane's queue policies deny everything to a principal they do not name: the API's task role is the one they name
# through `additional_principal_arns` (see README.md), and `aws_iam_role.api_task` must have exactly that ARN.

locals {
  logs_arn = "arn:${local.partition}:logs:${var.region}:${var.account_id}:log-group"

  # Each execution role: its log group, the secrets ECS reads for it, and the repositories it may pull from.
  execution = merge(
    {
      api     = { log_group = local.log_groups.api, secrets = compact([var.database_url_secret, var.webhook_key_secret]) }
      panel   = { log_group = local.log_groups.panel, secrets = [] }
      migrate = { log_group = local.log_groups.migrate, secrets = [local.migrate_url_secret] }
    },
    local.ingest ? { ingest = { log_group = local.log_groups.ingest, secrets = compact([var.database_url_secret, var.webhook_key_secret]) } } : {},
  )
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

resource "aws_iam_role" "api_task" {
  name               = "${var.name}-api-task"
  path               = "/"
  description        = "Qelay-Cloud control API: the queues' bells and depth, and nothing else"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "api_queues" {
  name = "use-the-queues"
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "RingAndReadDepth"
        Effect   = "Allow"
        Action   = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:SendMessage"] # SendMessageBatch is authorised by this action
        Resource = values(var.queue_arns)
      }],
      length(var.dead_letter_arns) == 0 ? [] : [{
        # The peek receives with a visibility timeout of zero and deletes nothing.
        Sid      = "PeekDeadLetters"
        Effect   = "Allow"
        Action   = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
        Resource = values(var.dead_letter_arns)
      }],
      var.monitoring_read ? [{
        # The age of the oldest message is a CloudWatch metric, and CloudWatch metric reads take no resource.
        Sid      = "ReadQueueMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricData"]
        Resource = ["*"]
      }] : [],
    )
  })
}

# Producers need both key actions, a receiver Decrypt; one statement keeps it the same shape as the workers'.
resource "aws_iam_role_policy" "api_queue_key" {
  count = var.queue_kms_key_arn == null ? 0 : 1

  name = "use-the-queue-key"
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "QueueKey"
      Effect    = "Allow"
      Action    = ["kms:GenerateDataKey", "kms:Decrypt"]
      Resource  = [var.queue_kms_key_arn]
      Condition = { StringEquals = { "kms:ViaService" = "sqs.${var.region}.amazonaws.com" } }
    }]
  })
}

resource "aws_iam_role" "execution" {
  for_each = local.execution

  name               = "${var.name}-${each.key}-execution"
  description        = "Qelay-Cloud control plane (${each.key}): ECS pulls the image, writes logs${length(each.value.secrets) == 0 ? "" : " and reads the secrets"} for it"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.execution

  name = "start-the-task"
  role = aws_iam_role.execution[each.key].id
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
          Resource = ["${local.logs_arn}:${each.value.log_group}:*"]
        },
      ],
      length(each.value.secrets) == 0 ? [] : [{
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = each.value.secrets
      }],
      length(var.image_repository_arns) == 0 ? [] : [{
        Sid      = "PullImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = var.image_repository_arns
      }],
      length(each.value.secrets) == 0 || var.secrets_kms_key_arn == null ? [] : [{
        Sid       = "DecryptSecrets"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = [var.secrets_kms_key_arn]
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
      }],
    )
  })
}
