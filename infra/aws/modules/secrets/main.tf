# Secrets Manager secrets for what must not travel as plain environment text: the database URL (it holds the
# password) and, behind a pooler, the direct URL. ECS reads them when a task starts, through the task's
# execution role, which is allowed to read the secrets its service uses and no other (the iam module).
#
# The values pass through the Terraform state, as every password a Terraform-created database has. The state
# bucket is therefore as sensitive as the secrets themselves.

resource "aws_secretsmanager_secret" "this" {
  for_each = var.secret_names

  name                    = "${var.name}/${each.key}"
  description             = "Qelay-Cloud ${var.name}: ${each.key}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each = var.secret_names

  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = var.secret_values[each.key]
}
