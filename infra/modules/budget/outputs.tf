output "required" {
  description = "Connections the fleet can open at full scale, by the mode chosen."
  value       = local.required
  depends_on  = [terraform_data.fits]
}

output "direct_required" {
  value = local.direct_required
}

output "pooled_required" {
  value = local.pooled_required
}

output "max_connections" {
  description = "The checked ceiling. The database takes its flag from here, so it is not planned unless the budget fits."
  value       = var.max_connections
  depends_on  = [terraform_data.fits]
}

output "utilization" {
  description = "required / max_connections."
  value       = local.utilization
}

output "worker_role_limit" {
  description = "CONNECTION LIMIT for the role the workers log in as (the worker share of the budget, by the mode chosen). Nothing here runs SQL: an operator sets it, see docs/operations.md."
  value       = local.worker_role_limit
}
