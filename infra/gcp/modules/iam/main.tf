# Identities, least privilege. There is no project-level binding and no primitive role (Owner, Editor,
# Viewer) anywhere in this configuration: every grant below is on one resource.
#
#   workers    publisher on the doorbell topic (the SDK and the in-process tick ring from the worker);
#              subscriber on its queues' subscriptions; accessor on the secrets it reads
#   tick       publisher on the doorbell topic; accessor on the secrets it reads
#   scheduler  invoker of the tick service (granted in the tick module, on that service); nothing else
#
# No Cloud SQL role is granted. The database is reached on its private IP with a password, over TLS, and a
# direct connection checks nothing against IAM. The Auth Proxy and the /cloudsql socket (which would need
# roles/cloudsql.client) are a tunnel, not a pooler, and this configuration does not use them.

resource "google_service_account" "workers" {
  account_id   = "${var.name}-workers"
  display_name = "Qelay-Cloud workers (${var.name})"
}

resource "google_service_account" "tick" {
  account_id   = "${var.name}-tick"
  display_name = "Qelay-Cloud maintenance tick (${var.name})"
}

resource "google_service_account" "scheduler" {
  account_id   = "${var.name}-scheduler"
  display_name = "Qelay-Cloud scheduler caller (${var.name})"
}

resource "google_pubsub_topic_iam_member" "workers_publish" {
  topic  = var.topic_name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.workers.email}"
}

resource "google_pubsub_topic_iam_member" "tick_publish" {
  topic  = var.topic_name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.tick.email}"
}

resource "google_pubsub_subscription_iam_member" "workers_subscribe" {
  for_each = var.subscription_names

  subscription = each.value
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.workers.email}"
}

resource "google_secret_manager_secret_iam_member" "workers_read" {
  for_each = var.worker_secrets

  secret_id = var.secret_ids[each.key]
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.workers.email}"
}

resource "google_secret_manager_secret_iam_member" "tick_read" {
  for_each = var.tick_secrets

  secret_id = var.secret_ids[each.key]
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.tick.email}"
}

locals {
  act_as = {
    for pair in setproduct(["workers", "tick", "scheduler"], var.deployer_members) :
    "${pair[0]}:${pair[1]}" => { account = pair[0], member = pair[1] }
  }
  account_ids = {
    workers   = google_service_account.workers.name
    tick      = google_service_account.tick.name
    scheduler = google_service_account.scheduler.name
  }
}

resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = local.act_as

  service_account_id = local.account_ids[each.value.account]
  role               = "roles/iam.serviceAccountUser"
  member             = each.value.member
}
