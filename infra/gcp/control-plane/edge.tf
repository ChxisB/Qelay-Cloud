# An external HTTPS load balancer with a Cloud Armor rate limit in front of the API and the panel (F16). Opt-in: see `edge`
# in variables.tf. Cloud Armor attaches to a load balancer's backend service, never to a Cloud Run URL, which is why this
# needs a load balancer at all, and why the services then take traffic from it alone (ingress, in main.tf).
#
# The API's own limiter is a token bucket per principal in each instance's memory, so N instances give a caller N times the
# limit and a restart forgets it. The rule here counts per client address across every instance, before a request reaches
# one. Both stay on: this is the first line, the API's is the second.

locals {
  edge_domains = local.edge ? sort([var.edge.api_hostname, var.edge.panel_hostname]) : []
}

resource "google_compute_global_address" "edge" {
  count = local.edge ? 1 : 0

  name = "${var.name}-edge"
}

resource "google_compute_security_policy" "edge" {
  count = local.edge ? 1 : 0

  name        = "${var.name}-edge"
  description = "Qelay-Cloud control plane: a rate limit per client address"

  rule {
    action      = "throttle"
    priority    = 1000
    description = "Over rate_limit_per_minute from one address: 429"

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = var.edge.rate_limit_per_minute
        interval_sec = 60
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default rule"

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_compute_region_network_endpoint_group" "api" {
  count = local.edge ? 1 : 0

  name                  = "${local.api_name}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_region_network_endpoint_group" "panel" {
  count = local.edge ? 1 : 0

  name                  = "${local.panel_name}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.panel.name
  }
}

# The backend timeout is the longest a request may last behind the load balancer. The API's event streams end by themselves
# after event_stream_lifetime_seconds, so the limit is the Cloud Run request timeout and the load balancer never cuts one.
resource "google_compute_backend_service" "api" {
  count = local.edge ? 1 : 0

  name                  = local.api_name
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  timeout_sec           = var.api_request_timeout_seconds
  security_policy       = google_compute_security_policy.edge[0].id

  backend {
    group = google_compute_region_network_endpoint_group.api[0].id
  }
}

resource "google_compute_backend_service" "panel" {
  count = local.edge ? 1 : 0

  name                  = local.panel_name
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  timeout_sec           = 60
  security_policy       = google_compute_security_policy.edge[0].id

  backend {
    group = google_compute_region_network_endpoint_group.panel[0].id
  }
}

# A host name that is neither of ours is sent to the panel's name. The certificate covers only the two names anyway.
resource "google_compute_url_map" "edge" {
  count = local.edge ? 1 : 0

  name = "${var.name}-edge"

  default_url_redirect {
    host_redirect          = var.edge.panel_hostname
    https_redirect         = true
    redirect_response_code = "FOUND"
    strip_query            = true
  }

  host_rule {
    hosts        = [var.edge.api_hostname]
    path_matcher = "api"
  }

  host_rule {
    hosts        = [var.edge.panel_hostname]
    path_matcher = "panel"
  }

  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.api[0].id
  }

  path_matcher {
    name            = "panel"
    default_service = google_compute_backend_service.panel[0].id
  }
}

# A certificate cannot be edited, so its name follows its domains and the new one exists before the old one goes.
resource "google_compute_managed_ssl_certificate" "edge" {
  count = local.edge ? 1 : 0

  name = "${var.name}-edge-${substr(md5(join(",", local.edge_domains)), 0, 8)}"

  managed {
    domains = local.edge_domains
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_ssl_policy" "edge" {
  count = local.edge ? 1 : 0

  name            = "${var.name}-edge"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "edge" {
  count = local.edge ? 1 : 0

  name             = "${var.name}-edge"
  url_map          = google_compute_url_map.edge[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.edge[0].id]
  ssl_policy       = google_compute_ssl_policy.edge[0].id
}

resource "google_compute_global_forwarding_rule" "edge" {
  count = local.edge ? 1 : 0

  name                  = "${var.name}-edge"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.edge[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.edge[0].id
}
