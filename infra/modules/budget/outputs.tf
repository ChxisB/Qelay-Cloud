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
