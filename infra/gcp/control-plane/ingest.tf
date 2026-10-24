# The inbound listener (`packages/ingest`): the public address a sender posts to, `/s/<token>`. Opt-in: see `ingest` in
# variables.tf. It validates, stores and answers; it never calls a destination, publishes to no queue and holds no job
# state, so it needs the database and nothing else (identity.tf: secret accessor only, no Pub/Sub role).
#
# It is a separate service from the API on purpose (D12). The API is for signed-in operators and carries the event
# streams; this one is open to the internet and takes one small request at a time. Its own limits (body size, a rate per
# source and a global one) are per process; the per-address limit is the edge's (`edge.ingest_rate_limit_per_minute`).

locals {
  ingest_name = "${var.name}-ingest"

  ingest_env = local.ingest ? merge(
    {
      QCLOUD_NAMESPACE          = var.namespace
      QCLOUD_DATABASE_POOL_SIZE = tostring(var.ingest.pool_size)
      QCLOUD_INGEST_HOST        = "0.0.0.0"
      QCLOUD_INGEST_PORT        = "8081"
    },
    local.database_env,
  ) : {}
}

resource "google_cloud_run_v2_service" "ingest" {
  count = local.ingest ? 1 : 0

  name                = local.ingest_name
  location            = var.region
  ingress             = local.ingress
  deletion_protection = false
  labels              = local.labels

  template {
    service_account                  = google_service_account.ingest[0].email
    timeout                          = "60s"
    max_instance_request_concurrency = var.ingest.concurrency

    scaling {
      min_instance_count = var.ingest.min_instances
      max_instance_count = var.ingest.max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
    }

    containers {
      image = var.ingest.image

      ports {
        container_port = 8081
      }

      resources {
        limits = {
          cpu    = var.ingest.cpu
          memory = var.ingest.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # `/healthz` touches nothing: a database that is down does not restart the listener, it makes the requests it
      # cannot store answer 503, which a sender retries.
      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 3
        timeout_seconds   = 2
        failure_threshold = 20
      }

      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }

      dynamic "env" {
        for_each = local.ingest_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "QCLOUD_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.database_url_secret.secret_id
            version = var.database_url_secret.version
          }
        }
      }

      dynamic "env" {
        for_each = var.webhook_key_secret == null ? [] : [var.webhook_key_secret]
        content {
          name = "QCLOUD_WEBHOOK_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = env.value.version
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = local.use_ca ? [1] : []
        content {
          name       = "database-ca"
          mount_path = local.ca_directory
        }
      }
    }

    dynamic "volumes" {
      for_each = local.use_ca ? [1] : []
      content {
        name = "database-ca"
        secret {
          secret = var.database_ca_secret.secret_id
          items {
            version = var.database_ca_secret.version
            path    = basename(local.ca_file)
            mode    = 256 # 0400
          }
        }
      }
    }
  }

  # The service reads its secrets at start: it must not be created before it is allowed to.
  depends_on = [google_secret_manager_secret_iam_member.ingest_read]
}
