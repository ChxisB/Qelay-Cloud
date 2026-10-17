# The doorbell: for each Qelay queue, a standard SQS queue and its dead-letter queue, with the names, tags and
# settings that packages/transport-aws/src/provision.ts (ensureQueue) creates, so a deployment provisioned
# here and a test provisioned there behave alike. scripts/check-terraform-plan-aws.ts compares the names to
# the transport's own `queueNames`, including the hashed form.
#
#   queue         qcloud-<namespace>__<queue>
#   dead letters  qcloud-<namespace>__<queue>__dlq
#
# A pair whose dead-letter name would pass 80 characters is hashed, as in names.ts:
#
#   queue         qcloud-h-<slug>-<20 hex digits of sha256 of ["<namespace>","<queue>"]>
#   dead letters  <that>-dlq
#
# The ARNs are written from the account, the region and the names, not read from the resources: they are then
# known at plan time, so the IAM statements that name them can be read in a plan, and the dead-letter queue is
# addressed by the main queue's redrive policy without a dependency between the two policies' contents.

locals {
  kms       = var.encryption == "kms"
  create    = local.kms && var.kms_key_arn == null
  key_arn   = local.kms ? (local.create ? aws_kms_key.queues[0].arn : var.kms_key_arn) : null
  plain     = { for name in keys(var.queues) : name => "qcloud-${var.namespace}__${name}" }
  hashed_by = { for name in keys(var.queues) : name => length(local.plain[name]) + length("__dlq") > 80 }
  digest    = { for name in keys(var.queues) : name => substr(sha256(jsonencode([var.namespace, name])), 0, 20) }
  # names.ts: the letters, digits and hyphens of "<namespace>-<queue>", at most 40 of them, without edge hyphens.
  slug = { for name in keys(var.queues) : name => trim(substr("${var.namespace}-${name}", 0, 40), "-") }
  queue_names = {
    for name in keys(var.queues) : name =>
    local.hashed_by[name] ? "qcloud-h-${local.slug[name] == "" ? "" : "${local.slug[name]}-"}${local.digest[name]}" : local.plain[name]
  }
  dead_letter_names = {
    for name, queue in local.queue_names : name =>
    local.hashed_by[name] ? "${queue}-dlq" : "${queue}__dlq"
  }
  arn_prefix       = "arn:${var.partition}:sqs:${var.region}:${var.account_id}:"
  queue_arns       = { for name, queue in local.queue_names : name => "${local.arn_prefix}${queue}" }
  dead_letter_arns = { for name, queue in local.dead_letter_names : name => "${local.arn_prefix}${queue}" }
  queue_tags = {
    for name in keys(var.queues) : name => merge(var.tags, {
      "qelay:namespace" = var.namespace
      "qelay:queue"     = name
    })
  }
}

resource "aws_kms_key" "queues" {
  count = local.create ? 1 : 0

  description             = "Qelay-Cloud doorbell queues (${var.namespace})"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = var.tags

  # The default key policy: the account's IAM policies decide who may use the key. Its Resource "*" is the
  # key itself; a key policy cannot name another resource.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EnableIamPolicies"
      Effect    = "Allow"
      Principal = { AWS = "arn:${var.partition}:iam::${var.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

resource "aws_kms_alias" "queues" {
  count = local.create ? 1 : 0

  name          = "alias/qcloud-${var.namespace}-queues"
  target_key_id = aws_kms_key.queues[0].key_id
}

resource "aws_sqs_queue" "dead_letter" {
  for_each = var.queues

  name                              = local.dead_letter_names[each.key]
  message_retention_seconds         = each.value.dead_letter_retention_seconds
  sqs_managed_sse_enabled           = local.kms ? null : true
  kms_master_key_id                 = local.key_arn
  kms_data_key_reuse_period_seconds = local.kms ? 300 : null
  tags                              = local.queue_tags[each.key]
}

# Only the queue it serves may use a dead-letter queue.
resource "aws_sqs_queue_redrive_allow_policy" "dead_letter" {
  for_each = var.queues

  queue_url = aws_sqs_queue.dead_letter[each.key].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [local.queue_arns[each.key]]
  })
}

resource "aws_sqs_queue" "main" {
  for_each = var.queues

  name                              = local.queue_names[each.key]
  visibility_timeout_seconds        = each.value.visibility_timeout_seconds
  message_retention_seconds         = each.value.retention_seconds
  sqs_managed_sse_enabled           = local.kms ? null : true
  kms_master_key_id                 = local.key_arn
  kms_data_key_reuse_period_seconds = local.kms ? 300 : null
  tags                              = local.queue_tags[each.key]

  redrive_policy = jsonencode({
    deadLetterTargetArn = local.dead_letter_arns[each.key]
    maxReceiveCount     = each.value.max_receive_count
  })

  depends_on = [aws_sqs_queue.dead_letter]
}
