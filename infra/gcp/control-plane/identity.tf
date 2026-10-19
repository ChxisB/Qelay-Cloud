# Identities, least privilege. No primitive role and no Cloud SQL role: every grant is on one resource,
# except the one optional project-level permission, which is a custom role of a single permission.
#
#   api      publisher on the doorbell topic (adding or retrying a job rings a bell); subscriber on the
#            dead-letter subscriptions (peek, then give the messages back); accessor on the database secrets and, when
#            webhooks are on, the webhook key;
#            read of Pub/Sub depth and age from Cloud Monitoring
#   panel    nothing: it serves static files and a config document built from its environment
#   migrate  accessor on the database secrets it needs: the direct URL (or the pooled one) and the CA

resource "google_service_account" "api" {
  account_id   = "${var.name}-api"
  display_name = "Qelay-Cloud control API (${var.name})"
}

resource "google_service_account" "panel" {
  account_id   = "${var.name}-panel"
  display_name = "Qelay-Cloud panel (${var.name})"
}

resource "google_service_account" "migrate" {
  account_id   = "${var.name}-migrate"
  display_name = "Qelay-Cloud schema migrations (${var.name})"
}

resource "google_pubsub_topic_iam_member" "api_publish" {
  topic  = var.topic_name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_pubsub_topic_iam_member" "api_publish_hot" {
  for_each = var.hot_topic_names

  topic  = each.value
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_pubsub_subscription_iam_member" "api_peek_dead_letters" {
  for_each = var.dead_letter_subscription_names

  subscription = each.value
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_read" {
  for_each = toset(local.api_secret_ids)

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "migrate_read" {
  for_each = toset(local.migrate_secret_ids)

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrate.email}"
}

# Cloud Monitoring has no per-resource IAM: reading a time series is a project permission. A custom
# role holds that one permission and nothing of dashboards, alert policies or logs.
resource "google_project_iam_custom_role" "metrics_reader" {
  count = var.monitoring_read ? 1 : 0

  role_id     = "qcloud_${replace(var.name, "-", "_")}_metrics_reader"
  title       = "Qelay-Cloud metrics reader (${var.name})"
  description = "Reads time series, for the Transport page's queue depth and age. Nothing else."
  permissions = ["monitoring.timeSeries.list"]
}

resource "google_project_iam_member" "api_reads_metrics" {
  count = var.monitoring_read ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.metrics_reader[0].name
  member  = "serviceAccount:${google_service_account.api.email}"
}

locals {
  act_as = {
    for pair in setproduct(["api", "panel", "migrate"], var.deployer_members) :
    "${pair[0]}:${pair[1]}" => { account = pair[0], member = pair[1] }
  }
  account_ids = {
    api     = google_service_account.api.name
    panel   = google_service_account.panel.name
    migrate = google_service_account.migrate.name
  }
}

resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = local.act_as

  service_account_id = local.account_ids[each.value.account]
  role               = "roles/iam.serviceAccountUser"
  member             = each.value.member
}
