# The maintenance tick as an HTTP endpoint for Cloud Scheduler (`qcloud-tick serve`).
#
# Two checks guard the endpoint, and both must pass: Cloud Run's IAM (only the scheduler's service account
# holds run.invoker) and the application's own OIDC check (audience and allowed email). There is no
# unauthenticated path and no shared secret in this configuration.
#
# The tick is idempotent and elects its own leader with a lease row, so it needs no more than one instance;
# the budget counts that one. It scales to zero between calls: the scheduler's job is the minute's safety
# net, and a service that wakes once a minute costs only the minutes it runs. (An always-on worker that
# runs the in-process tick gives the second-level precision; this is the floor under it.)

locals {
  audience = "https://${var.name}-${var.project_number}.${var.region}.run.app"
  files = {
    for path, secret in var.secret_files :
    path => {
      directory = dirname(path)
      file      = basename(path)
      volume    = "secret-${substr(sha1(path), 0, 8)}"
      secret    = secret
    }
  }
}

resource "google_cloud_run_v2_service" "tick" {
  name                = var.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  labels              = var.labels

  template {
    service_account = var.service_account_email
    timeout         = "300s"

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
    }

    containers {
      image   = var.image
      command = var.command
      args    = ["serve"]

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "QCLOUD_DATABASE_POOL_SIZE"
        value = tostring(var.pool_size)
      }
      env {
        name  = "QCLOUD_TICK_AUDIENCE"
        value = local.audience
      }
      env {
        name  = "QCLOUD_TICK_ALLOWED_EMAILS"
        value = var.scheduler_service_account_email
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = env.value.version
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = local.files
        content {
          name       = volume_mounts.value.volume
          mount_path = volume_mounts.value.directory
        }
      }
    }

    dynamic "volumes" {
      for_each = local.files
      content {
        name = volumes.value.volume
        secret {
          secret = volumes.value.secret.secret_id
          items {
            version = volumes.value.secret.version
            path    = volumes.value.file
            mode    = 256 # 0400
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invokes" {
  project  = google_cloud_run_v2_service.tick.project
  location = google_cloud_run_v2_service.tick.location
  name     = google_cloud_run_v2_service.tick.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.scheduler_service_account_email}"
}

# The audience is computed from the project number so the scheduler job and the tick agree before the
# service exists. If Cloud Run's URL scheme ever differs from the computed one, every call is a 401; this
# check says so on the next plan instead of leaving the cause to be found in the logs.
check "audience_is_the_service_url" {
  assert {
    condition     = google_cloud_run_v2_service.tick.uri == local.audience
    error_message = "The tick's URL is ${google_cloud_run_v2_service.tick.uri}, not ${local.audience}: the OIDC audience is wrong, and every scheduler call will be refused. Set a custom audience."
  }
}
