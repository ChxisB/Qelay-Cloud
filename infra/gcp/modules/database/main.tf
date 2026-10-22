# Cloud SQL for PostgreSQL 18, private IP only, encrypted connections only, with backups and
# point-in-time recovery and two layers of deletion protection.
#
# A direct private-IP connection with a password needs no Cloud SQL IAM role: the Auth Proxy and the
# /cloudsql socket (which do) are a tunnel and an authenticator, and this module does not use them.

resource "random_password" "database" {
  length  = 32
  special = false # the password travels in a URL, so it uses no character that needs escaping
}

resource "google_sql_database_instance" "main" {
  name                = "${var.name}-pg"
  region              = var.region
  database_version    = "POSTGRES_18"
  deletion_protection = var.deletion_protection

  settings {
    tier                        = var.tier
    edition                     = var.edition
    availability_type           = var.high_availability ? "REGIONAL" : "ZONAL"
    disk_size                   = var.disk_size_gb
    disk_type                   = var.disk_type
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection
    user_labels                 = var.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
      # The driver's default is plaintext, so the server refuses it.
      ssl_mode = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = var.backup_start_time
      transaction_log_retention_days = var.transaction_log_retention_days

      backup_retention_settings {
        retained_backups = var.retained_backups
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = var.maintenance_day
      hour         = var.maintenance_hour
      update_track = "stable"
    }

    database_flags {
      name  = "max_connections"
      value = tostring(var.max_connections)
    }

    database_flags {
      name  = "statement_timeout"
      value = tostring(var.session_timeouts.statement_ms)
    }

    database_flags {
      name  = "lock_timeout"
      value = tostring(var.session_timeouts.lock_ms)
    }

    database_flags {
      name  = "idle_in_transaction_session_timeout"
      value = tostring(var.session_timeouts.idle_in_transaction_ms)
    }

    dynamic "connection_pool_config" {
      for_each = var.managed_pooling ? [1] : []
      content {
        # Google's defaults: 50 server connections per database and user pair, 5,000 client connections.
        connection_pooling_enabled = true
      }
    }
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = !var.managed_pooling || var.edition == "ENTERPRISE_PLUS"
      error_message = "Managed connection pooling needs edition = \"ENTERPRISE_PLUS\" (and a db-perf-optimization tier)."
    }
  }
}

resource "google_sql_database" "app" {
  name     = var.database_name
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = var.user_name
  instance = google_sql_database_instance.main.name
  password = random_password.database.result
}
