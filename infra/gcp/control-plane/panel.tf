# The panel (`server.js`, the static build). It holds no database connection and no secret: the page and a
# `/config.json` built from the environment at start, which names the API and the identity provider and
# holds nothing a visitor could not read in the page anyway.

locals {
  panel_env = merge(
    {
      QCLOUD_PANEL_API_BASE_URL = local.api_url
      QCLOUD_PANEL_AUTH_MODE    = "oidc"
      # The authority and the client id are public by nature (the browser sends users to the first and
      # names itself with the second). A client secret would be refused by the panel at start.
      QCLOUD_PANEL_OIDC_AUTHORITY = local.oidc_authority
      QCLOUD_PANEL_OIDC_CLIENT_ID = var.oidc_client_id
    },
    var.oidc_scope == null ? {} : { QCLOUD_PANEL_OIDC_SCOPE = var.oidc_scope },
    var.oidc_token_audience == null ? {} : { QCLOUD_PANEL_OIDC_AUDIENCE = var.oidc_token_audience },
    length(var.panel_csp_connect_extra) == 0 ? {} : { QCLOUD_PANEL_CSP_CONNECT_EXTRA = join(" ", var.panel_csp_connect_extra) },
  )
}

resource "google_cloud_run_v2_service" "panel" {
  name                = local.panel_name
  location            = var.region
  ingress             = local.private ? "INGRESS_TRAFFIC_INTERNAL_ONLY" : "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  labels              = local.labels

  template {
    service_account = google_service_account.panel.email
    timeout         = "60s"

    # No egress: the panel's only network use is answering the browser.
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = var.panel_min_instances
      max_instance_count = var.panel_max_instances
    }

    containers {
      image = var.panel_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.panel_cpu
          memory = var.panel_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 2
        timeout_seconds   = 1
        failure_threshold = 10
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
        for_each = local.panel_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}
