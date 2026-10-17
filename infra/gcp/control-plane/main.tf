# The control plane on GCP: the Control API and the panel as Cloud Run services, and the migration job.
# Read ../README.md first. It sits beside the data plane (`../example`), not inside it: the data plane is
# applied once and rarely, the control plane every time a build is released, and the two have different
# owners. They meet at the values listed under "From the data plane" in variables.tf.
#
# What is NOT here, because the data plane already has it: the maintenance tick's service and the Cloud
# Scheduler job that calls it with the scheduler's OIDC token (../modules/tick, ../modules/scheduler).

locals {
  labels = merge({ app = "qelay-cloud", environment = var.name, component = "control-plane" }, var.labels)

  api_name   = "${var.name}-api"
  panel_name = "${var.name}-panel"

  # Cloud Run's URL for a service is deterministic, so each side can name the other before it exists.
  # The `check` blocks below say so on the next plan if the scheme ever differs.
  api_url   = "https://${local.api_name}-${var.project_number}.${var.region}.run.app"
  panel_url = "https://${local.panel_name}-${var.project_number}.${var.region}.run.app"

  private = var.exposure == "private"

  use_ca = var.database_tls == "ca-file"

  ca_directory = "/etc/qcloud/db-ca"
  ca_file      = "${local.ca_directory}/ca.pem"

  tls_env = {
    "ca-file"    = tomap({ QCLOUD_DATABASE_TLS_CA_FILE = local.ca_file })
    "unverified" = tomap({ QCLOUD_DATABASE_TLS = "unverified" })
    "off"        = tomap({ QCLOUD_DATABASE_TLS = "off" })
  }

  # The migration reads the direct URL when there is one: DDL runs on the database, not behind a pooler.
  migrate_url_secret = coalesce(var.database_direct_url_secret, var.database_url_secret)
  migrate_pooled     = var.database_direct_url_secret == null && var.pooled

  # The API talks to the database through whatever the data plane's URL points at.
  database_env = merge(
    {
      QCLOUD_DATABASE_POOLER = var.pooled ? "transaction" : "none"
    },
    local.tls_env[var.database_tls],
  )

  # Secrets: names of the Secret Manager entries the services read. Their values never appear here.
  api_secret_ids = distinct(compact([
    var.database_url_secret.secret_id,
    local.use_ca ? var.database_ca_secret.secret_id : "",
  ]))
  migrate_secret_ids = distinct(compact([
    local.migrate_url_secret.secret_id,
    local.use_ca ? var.database_ca_secret.secret_id : "",
  ]))

  # The subnet is the data plane's. Direct VPC egress gives every instance an address, and a rollover runs
  # two revisions together, so every instance counts twice. The data plane counted its own; these are ours
  # (the API, the panel and one migration task).
  subnet_prefix   = tonumber(split("/", var.subnet_cidr)[1])
  subnet_usable   = pow(2, 32 - local.subnet_prefix) - 4 # Google reserves four addresses of every subnet
  instances_total = var.data_plane_instances + var.api_max_instances + var.panel_max_instances + 1
  subnet_required = 2 * local.instances_total

  oidc_authority = coalesce(var.oidc_authority, var.oidc_issuer)
}

resource "terraform_data" "inputs" {
  input = var.name

  lifecycle {
    precondition {
      condition     = !local.use_ca || var.database_ca_secret != null
      error_message = "database_tls = \"ca-file\" needs database_ca_secret: the secret that holds the database's CA certificate."
    }
    precondition {
      condition     = var.database_tls != "off" || var.pooled
      error_message = "database_tls = \"off\" needs a pooler (pooled = true): the instance accepts only encrypted connections."
    }
    precondition {
      condition     = 1 + var.api_max_instances <= var.budgeted_control_processes
      error_message = "The connection budget counts ${var.budgeted_control_processes} control processes (the tick and each API instance): ${1 + var.api_max_instances} would run at full scale. Raise the data plane's control_processes, or lower api_max_instances."
    }
    precondition {
      condition     = var.api_pool_size <= var.budgeted_control_pool_size
      error_message = "The connection budget counts ${var.budgeted_control_pool_size} connections per control process; api_pool_size is ${var.api_pool_size}. Raise the data plane's control_pool_size, or lower api_pool_size."
    }
    precondition {
      condition     = var.api_min_instances >= 0 && var.api_min_instances <= var.api_max_instances
      error_message = "api_min_instances must be between 0 and api_max_instances."
    }
    precondition {
      condition     = var.panel_min_instances >= 0 && var.panel_min_instances <= var.panel_max_instances
      error_message = "panel_min_instances must be between 0 and panel_max_instances."
    }
    precondition {
      condition     = var.api_request_timeout_seconds <= 3600 && var.api_request_timeout_seconds >= var.event_stream_lifetime_seconds + 60
      error_message = "api_request_timeout_seconds (${var.api_request_timeout_seconds}) must be at most 3600 and at least a minute more than event_stream_lifetime_seconds (${var.event_stream_lifetime_seconds}): the API must close a stream before Cloud Run cuts the request."
    }
    precondition {
      condition     = var.event_heartbeat_seconds >= 15 && var.event_heartbeat_seconds <= 60
      error_message = "event_heartbeat_seconds must be between 15 and 60."
    }
    precondition {
      condition     = var.api_event_streams < var.api_concurrency
      error_message = "api_event_streams (${var.api_event_streams}) must be below api_concurrency (${var.api_concurrency}): a stream holds a request slot, and ordinary requests need slots too."
    }
    precondition {
      condition     = local.subnet_required <= local.subnet_usable
      error_message = "The subnet ${var.subnet_cidr} has ${local.subnet_usable} usable addresses; the whole environment (${var.data_plane_instances} instances from the data plane, plus the control plane's) needs ${local.subnet_required} during a rollover. Use a larger subnet_cidr in the data plane, or lower max instances."
    }
    precondition {
      condition     = alltrue([for origin in concat(var.extra_cors_origins, var.panel_csp_connect_extra) : can(regex("^https?://[^/*]+$", origin))])
      error_message = "extra_cors_origins and panel_csp_connect_extra take exact origins (scheme and host, no path, no wildcard)."
    }
  }
}

# --- the URLs the services were configured with ----------------------------------------------------------------
#
# The panel's CORS origin and the API's base URL are computed from the project number. If Cloud Run's URL
# scheme differs from the computed one, every cross-origin call fails; these checks say so at the next plan.

check "api_url_is_the_service_url" {
  assert {
    condition     = google_cloud_run_v2_service.api.uri == local.api_url
    error_message = "The API's URL is ${google_cloud_run_v2_service.api.uri}, not ${local.api_url}: the panel is configured with the wrong base URL."
  }
}

check "panel_url_is_the_service_url" {
  assert {
    condition     = google_cloud_run_v2_service.panel.uri == local.panel_url
    error_message = "The panel's URL is ${google_cloud_run_v2_service.panel.uri}, not ${local.panel_url}: the API's CORS list does not name it, and every call from the panel is refused."
  }
}
