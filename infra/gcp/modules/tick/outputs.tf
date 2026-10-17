output "name" {
  value = google_cloud_run_v2_service.tick.name
}

output "url" {
  description = "The service's URL, as Cloud Run reports it."
  value       = google_cloud_run_v2_service.tick.uri
}

output "audience" {
  description = "The OIDC audience: what the scheduler signs for and what the tick requires. Known before the service exists."
  value       = local.audience
}

output "tick_url" {
  description = "The endpoint the scheduler posts to."
  value       = "${local.audience}/internal/tick"
}
