output "ids" {
  description = "Secret id suffix => the secret's full resource id (projects/<project>/secrets/<id>)."
  value       = { for key, secret in google_secret_manager_secret.this : key => secret.id }
}

output "secret_ids" {
  description = "Secret id suffix => the secret's short id."
  value       = { for key, secret in google_secret_manager_secret.this : key => secret.secret_id }
}

output "version_ids" {
  description = "Secret id suffix => the version resource. A service that mounts it waits for it."
  value       = { for key, version in google_secret_manager_secret_version.this : key => version.id }
}

output "version_numbers" {
  description = "Secret id suffix => the version number a service pins. A new value is a new number, so the services that read it roll a new revision."
  value       = { for key, version in google_secret_manager_secret_version.this : key => version.version }
}
