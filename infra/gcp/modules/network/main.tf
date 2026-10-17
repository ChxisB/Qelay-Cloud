# The VPC that holds the workers' subnet and the peering to Cloud SQL's private IP.
#
# Cloud Run reaches the database through Direct VPC egress, not a Serverless VPC Access connector:
# a connector is billed as always-on instances, and the connection budget is the same either way
# (a connector is a tunnel, not a pooler).

resource "google_compute_network" "main" {
  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "workers" {
  name                     = "${var.name}-workers"
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  name          = "${var.name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_services_prefix_length
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
  deletion_policy         = var.abandon_peering_on_destroy ? "ABANDON" : null
}
