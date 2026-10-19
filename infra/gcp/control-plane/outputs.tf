output "api_url" {
  description = "The Control API's base URL: what the panel is configured with."
  value       = local.api_url
}

output "panel_url" {
  description = "Where users open the panel."
  value       = local.panel_url
}

output "exposure" {
  value = var.exposure
}

output "edge" {
  description = "The load balancer's address when `edge` is set, else null: point the two host names at ip_address."
  value = local.edge ? {
    ip_address     = google_compute_global_address.edge[0].address
    api_hostname   = var.edge.api_hostname
    panel_hostname = var.edge.panel_hostname
  } : null
}

output "migrate_job" {
  description = "The migration job's name: gcloud run jobs execute <name> --region <region> --wait"
  value       = google_cloud_run_v2_job.migrate.name
}

output "service_accounts" {
  value = {
    api     = google_service_account.api.email
    panel   = google_service_account.panel.email
    migrate = google_service_account.migrate.email
  }
}

output "event_stream" {
  description = "The numbers that keep a stream from being cut mid-event, for the runbook and the smoke test."
  value = {
    request_timeout_seconds = var.api_request_timeout_seconds
    lifetime_seconds        = var.event_stream_lifetime_seconds
    heartbeat_seconds       = var.event_heartbeat_seconds
    streams_per_instance    = var.api_event_streams
    concurrency             = var.api_concurrency
  }
}

output "oidc_redirect_uris" {
  description = "Register these at the identity provider as the panel's redirect (and post-logout) URIs."
  value       = [local.panel_url, "${local.panel_url}/"]
}

output "alert_policy_ids" {
  description = "The control plane's alert policies: policy => id."
  value       = { for policy in google_monitoring_alert_policy.api_errors : "api_errors" => policy.id }
}
