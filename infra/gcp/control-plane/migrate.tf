# The schema migration as a Cloud Run Job (`qcloud-api migrate`), run by the release process before the
# services roll to a build that needs a newer schema, and never from a serving instance: instances that
# start together would race to migrate, which is the classic outage. The job holds one advisory lock
# for the migration (transaction-scoped, so a pooler is safe), exits 0 when the database is current and
# non-zero otherwise, and a new service revision reports `schema: behind` from `/health/ready` until it
# has run. Migrations only add: an old revision keeps serving against the newer schema while they roll.
#
# The job's image is the API's, so one build is both. It is a job, not a service: nothing listens, there
# is no URL, and it costs the minutes it runs.

resource "google_cloud_run_v2_job" "migrate" {
  name                = "${var.name}-migrate"
  location            = var.region
  deletion_protection = false
  labels              = local.labels

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account = google_service_account.migrate.email
      timeout         = "${var.migrate_timeout_seconds}s"
      # No retries: a failed migration is read, not repeated. The migration is idempotent, so running
      # the job again is always safe, and it is a decision a person makes.
      max_retries = 0

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = var.network
          subnetwork = var.subnetwork
        }
      }

      containers {
        image = var.api_image
        args  = ["migrate"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "QCLOUD_DATABASE_POOLER"
          value = local.migrate_pooled ? "transaction" : "none"
        }
        dynamic "env" {
          for_each = local.tls_env[var.database_tls]
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name  = "QCLOUD_DATABASE_POOL_SIZE"
          value = "1"
        }
        env {
          name = "QCLOUD_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = local.migrate_url_secret.secret_id
              version = local.migrate_url_secret.version
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
  }

  depends_on = [google_secret_manager_secret_iam_member.migrate_read]
}
