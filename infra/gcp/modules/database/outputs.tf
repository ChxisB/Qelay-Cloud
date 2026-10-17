output "instance_name" {
  value = google_sql_database_instance.main.name
}

output "connection_name" {
  description = "project:region:instance, for the Auth Proxy or the /cloudsql socket (which this configuration does not use)."
  value       = google_sql_database_instance.main.connection_name
}

output "private_ip_address" {
  value = google_sql_database_instance.main.private_ip_address
}

output "database_name" {
  value = google_sql_database.app.name
}

output "user_name" {
  value = google_sql_user.app.name
}

output "password" {
  description = "The application role's password. It is in the Terraform state: keep the state in a bucket only operators can read."
  value       = random_password.database.result
  sensitive   = true
}

output "server_ca_cert" {
  description = "The instance's CA certificate (PEM): what a client passes as the trusted CA."
  value       = google_sql_database_instance.main.server_ca_cert[0].cert
}

output "max_connections" {
  value = var.max_connections
}
