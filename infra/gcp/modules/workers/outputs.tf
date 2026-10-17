output "name" {
  value = google_cloud_run_v2_worker_pool.worker.name
}

output "max_instances" {
  description = "What the budget counts."
  value       = var.max_instances
}

output "pool_size" {
  description = "What the budget counts."
  value       = var.pool_size
}

output "min_instances" {
  description = "The count the pool is created with, and the autoscaler's floor."
  value       = var.min_instances
}
