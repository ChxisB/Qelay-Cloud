# Backlog autoscaling for Cloud Run worker pools, with Google's CREMA (Cloud Run External Metrics Autoscaling,
# built on KEDA). A worker pool does not scale by itself. CREMA is one small always-on Cloud Run service that
# reads a YAML config from Parameter Manager every polling interval, reads each target's Pub/Sub subscription
# backlog from Cloud Monitoring, and sets the pool's instance count through the Cloud Run Admin API.
#
# - It costs one always-on instance (the service below: min = max = 1, CPU always allocated). That is why it is
#   opt-in: a fleet of one or two workers does not need it.
# - The count is desired = ceil(backlog / backlog_per_instance), clamped to [min_instances, max_instances]. The
#   ceiling is the connection budget's: Cloud Run does not enforce one on a pool, so this is the only place it is
#   enforced.
# - Grants are on one resource each, except two read-only project-level ones: monitoring.viewer (Cloud Monitoring
#   has no resource-level binding for reading a project's metrics) and parametermanager.parameterViewer (the
#   provider has no IAM resource for a single parameter).
# - The service takes no request and nothing may invoke it: ingress is internal and no invoker is granted.

locals {
  # The config is generated, so a pool, a subscription and the floor and ceiling cannot disagree with Terraform.
  config = {
    apiVersion = "crema/v1"
    kind       = "CremaConfig"
    spec = {
      pollingInterval = var.polling_interval_seconds
      triggerAuthentications = [{
        metadata = { name = "adc-trigger-auth" }
        spec     = { podIdentity = { provider = "gcp" } }
      }]
      scaledObjects = [
        for pool, target in var.targets : {
          spec = {
            # The Admin API's own spelling is workerPools. Google's codelab writes workerpools: not run here.
            scaleTargetRef  = { name = "projects/${var.project_id}/locations/${var.region}/workerPools/${pool}" }
            minReplicaCount = target.min_instances
            maxReplicaCount = target.max_instances
            triggers = [{
              type = "gcp-pubsub"
              metadata = {
                subscriptionName = target.subscription
                mode             = "SubscriptionSize"
                value            = tostring(target.backlog_per_instance)
              }
              authenticationRef = { name = "adc-trigger-auth" }
            }]
          }
        }
      ]
    }
  }
}

resource "google_service_account" "autoscaler" {
  account_id   = "${var.name}-autoscaler"
  display_name = "Qelay-Cloud worker autoscaler (${var.name})"
}

resource "google_parameter_manager_parameter" "config" {
  parameter_id = "${var.name}-crema-config"
  format       = "YAML"
  labels       = var.labels
}

resource "google_parameter_manager_parameter_version" "config" {
  parameter            = google_parameter_manager_parameter.config.id
  parameter_version_id = "v-${substr(sha1(yamlencode(local.config)), 0, 12)}"
  parameter_data       = yamlencode(local.config)

  # The service reads the old version until the new revision is up.
  lifecycle {
    create_before_destroy = true
  }
}

# The provider has no IAM resource for one parameter (6.50.0), so this is project-wide: the account can read every
# parameter of the project. Keep nothing secret in Parameter Manager here; secrets belong in Secret Manager.
resource "google_project_iam_member" "read_config" {
  project = var.project_id
  role    = "roles/parametermanager.parameterViewer"
  member  = "serviceAccount:${google_service_account.autoscaler.email}"
}

resource "google_cloud_run_v2_worker_pool_iam_member" "scale" {
  for_each = var.targets

  location = var.region
  name     = each.key
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.autoscaler.email}"
}

resource "google_pubsub_subscription_iam_member" "read_backlog" {
  for_each = var.targets

  subscription = each.value.subscription
  role         = "roles/pubsub.viewer"
  member       = "serviceAccount:${google_service_account.autoscaler.email}"
}

resource "google_service_account_iam_member" "acts_as_workers" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.workers_service_account_email}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.autoscaler.email}"
}

resource "google_project_iam_member" "read_metrics" {
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:${google_service_account.autoscaler.email}"
}

resource "google_cloud_run_v2_service" "autoscaler" {
  name                = "${var.name}-autoscaler"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false
  labels              = merge(var.labels, { "created-by" = "crema" })

  template {
    service_account = google_service_account.autoscaler.email

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = false # it polls on a timer, with no request in flight
      }

      env {
        name  = "CREMA_CONFIG"
        value = google_parameter_manager_parameter_version.config.name
      }
    }
  }

  depends_on = [
    google_project_iam_member.read_config,
    google_cloud_run_v2_worker_pool_iam_member.scale,
    google_pubsub_subscription_iam_member.read_backlog,
    google_service_account_iam_member.acts_as_workers,
    google_project_iam_member.read_metrics,
  ]
}
