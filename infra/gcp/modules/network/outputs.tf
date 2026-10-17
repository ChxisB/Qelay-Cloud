output "network_id" {
  description = "The VPC, once the private services peering exists: a database that uses this id waits for the peering."
  value       = google_compute_network.main.id
  depends_on  = [google_service_networking_connection.private_services]
}

output "network_name" {
  description = "The VPC's name, for Direct VPC egress."
  value       = google_compute_network.main.name
}

output "subnetwork_name" {
  description = "The workers' subnet, for Direct VPC egress."
  value       = google_compute_subnetwork.workers.name
}
