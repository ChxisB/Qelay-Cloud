# Who may call the services. See `exposure` in variables.tf, and docs/runbooks/deploy-gcp.md for why
# "public" is the default.
#
# `allUsers` here does not open the API: Cloud Run's IAM check is the first of two, and the application's
# token check is the second. The API answers 401 to anything without a valid token except `GET /health`,
# and the panel serves only the static build and a config document that holds no secret. A private
# deployment (exposure = "private") has the same two checks behind an internal-only ingress, which is
# reachable from the VPC alone.
#
# An organisation that forbids `allUsers` (domain-restricted sharing) cannot use this file as it is: its
# Cloud Run services need `invoker_iam_disabled = true` instead, which this provider version supports and
# the runbook describes.

resource "google_cloud_run_v2_service_iam_member" "api_invoker" {
  project  = google_cloud_run_v2_service.api.project
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "panel_invoker" {
  project  = google_cloud_run_v2_service.panel.project
  location = google_cloud_run_v2_service.panel.location
  name     = google_cloud_run_v2_service.panel.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
