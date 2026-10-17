output "address" {
  description = "The instance's DNS name (private addresses only)."
  value       = aws_db_instance.main.address
}

output "port" {
  value = aws_db_instance.main.port
}

output "database_name" {
  value = aws_db_instance.main.db_name
}

output "user_name" {
  value = aws_db_instance.main.username
}

output "password" {
  description = "The generated password. Only the secrets module is meant to receive it."
  value       = random_password.database.result
  sensitive   = true
}

output "identifier" {
  description = "The instance identifier, the CloudWatch dimension of its metrics."
  value       = aws_db_instance.main.identifier
}

output "security_group_id" {
  value = aws_security_group.database.id
}

output "proxy_endpoint" {
  description = "The proxy's DNS name, or null without one."
  value       = local.proxy ? aws_db_proxy.main[0].endpoint : null
}

output "proxy_server_connections" {
  description = "The server connections the proxy may open: its share of max_connections. Null without a proxy."
  value       = local.proxy ? floor(var.max_connections * var.proxy.max_connections_percent / 100) : null
}
