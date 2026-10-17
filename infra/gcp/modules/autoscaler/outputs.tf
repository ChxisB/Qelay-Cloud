output "service_name" {
  value = google_cloud_run_v2_service.autoscaler.name
}

output "config_version" {
  description = "The Parameter Manager version the autoscaler runs. It changes with the config, so a change to a target is a new revision."
  value       = google_parameter_manager_parameter_version.config.name
}
