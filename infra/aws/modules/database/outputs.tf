locals {
  instance = local.cluster ? null : aws_db_instance.main[0]
  writer   = local.cluster ? aws_rds_cluster.main[0] : null
}

output "address" {
  description = "The DNS name to connect to (private addresses only): the instance's, or the cluster's writer endpoint."
  value       = local.cluster ? local.writer.endpoint : local.instance.address
}

output "port" {
  value = local.cluster ? local.writer.port : local.instance.port
}

output "database_name" {
  value = var.database_name
}

output "user_name" {
  value = var.user_name
}

output "password" {
  description = "The generated password. Only the secrets module is meant to receive it."
  value       = random_password.database.result
  sensitive   = true
}

output "identifier" {
  description = "The instance identifier, or the cluster identifier with a cluster: the CloudWatch dimension of its metrics."
  value       = local.cluster ? local.writer.cluster_identifier : local.instance.identifier
}

output "metric_dimension" {
  description = "The name of that CloudWatch dimension."
  value       = local.cluster ? "DBClusterIdentifier" : "DBInstanceIdentifier"
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
