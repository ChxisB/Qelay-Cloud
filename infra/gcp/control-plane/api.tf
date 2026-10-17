# The Control API (`qcloud-api serve`). One image, configured only by its environment: variables.tf is the
# source of every value, and docs/runbooks/deploy-gcp.md has the table of what each one means.
#
# Timeouts, from the outside in:
#   Cloud Run request timeout   api_request_timeout_seconds (900 s; at most 3600)
#   event stream lifetime       event_stream_lifetime_seconds (600 s): the API closes the stream, the client
#                               resumes with Last-Event-ID, and the platform never has to cut a request
#   server idle timeout         255 s, the most Bun allows (set in the image's code, not here)
#   heartbeat                   event_heartbeat_seconds (15 s): a comment line, so nothing in front sees an
#                               idle connection
# Concurrency is deliberate: a stream holds a request slot for its whole life, so api_event_streams is
# below api_concurrency, and the slots left over are for reads and writes.

locals {
  fleet_env = var.fleet == null ? {} : merge(
    { QCLOUD_FLEET_WORKERS = tostring(var.fleet.workers) },
    var.fleet.pool_size == null ? {} : { QCLOUD_FLEET_POOL_SIZE = tostring(var.fleet.pool_size) },
    var.fleet.listeners == null ? {} : { QCLOUD_FLEET_LISTENERS = tostring(var.fleet.listeners) },
    var.fleet.control_processes == null ? {} : { QCLOUD_FLEET_CONTROL_PROCESSES = tostring(var.fleet.control_processes) },
    var.fleet.pooler_pool_size == null ? {} : { QCLOUD_FLEET_POOLER_POOL_SIZE = tostring(var.fleet.pooler_pool_size) },
  )

  api_env = merge(
    {
      QCLOUD_NAMESPACE          = var.namespace
      QCLOUD_TRANSPORT          = "gcp-pubsub"
      QCLOUD_GCP_PROJECT        = var.project_id
      QCLOUD_DATABASE_POOL_SIZE = tostring(var.api_pool_size)

      QCLOUD_API_OIDC_ISSUER   = var.oidc_issuer
      QCLOUD_API_OIDC_AUDIENCE = join(",", var.oidc_audience)
      QCLOUD_API_OIDC_JWKS_URL = var.oidc_jwks_url
      QCLOUD_API_CORS_ORIGINS  = join(",", concat([local.panel_url], var.extra_cors_origins))

      QCLOUD_API_EVENTS_HEARTBEAT_MS    = tostring(var.event_heartbeat_seconds * 1000)
      QCLOUD_API_EVENTS_MAX_LIFETIME_MS = tostring(var.event_stream_lifetime_seconds * 1000)
      QCLOUD_API_EVENTS_MAX_STREAMS     = tostring(var.api_event_streams)
    },
    local.database_env,
    local.fleet_env,
    var.role_claim == null ? {} : { QCLOUD_API_ROLE_CLAIM = var.role_claim },
    var.operator_roles == null ? {} : { QCLOUD_API_OPERATOR_ROLES = join(",", var.operator_roles) },
    var.viewer_roles == null ? {} : { QCLOUD_API_VIEWER_ROLES = join(",", var.viewer_roles) },
  )
}

resource "google_cloud_run_v2_service" "api" {
  name                = local.api_name
  location            = var.region
  ingress             = local.private ? "INGRESS_TRAFFIC_INTERNAL_ONLY" : "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  labels              = local.labels

  template {
    service_account                  = google_service_account.api.email
    timeout                          = "${var.api_request_timeout_seconds}s"
    max_instance_request_concurrency = var.api_concurrency

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
    }

    containers {
      image = var.api_image
      args  = ["serve"]

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.api_cpu
          memory = var.api_memory
        }
        # An open event stream is a request in flight, so CPU is allocated while one is open. Between
        # requests the instance is throttled, which is what the idle price buys.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # `/health` is the only route without a token, and it touches nothing: a database that is down
      # does not restart the API, it makes `/health/ready` (behind the token) report why.
      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 3
        timeout_seconds   = 2
        failure_threshold = 20
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }

      dynamic "env" {
        for_each = local.api_env
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
  depends_on = [
    google_secret_manager_secret_iam_member.api_read,
    google_pubsub_topic_iam_member.api_publish,
  ]
}
