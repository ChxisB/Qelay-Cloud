output "names" {
  description = "Key => the secret's name. Known at plan time."
  value       = { for key in var.secret_names : key => "${var.name}/${key}" }
}

output "arns" {
  description = "Key => the secret's ARN, which carries a random suffix and so is known only once the secret exists. This is what a task definition's valueFrom takes."
  value       = { for key, secret in aws_secretsmanager_secret.this : key => secret.arn }
}

output "version_ids" {
  description = "Key => the current version's id. A new value is a new id, so the services that read it can be rolled when it changes."
  value       = { for key, version in aws_secretsmanager_secret_version.this : key => version.version_id }
}
