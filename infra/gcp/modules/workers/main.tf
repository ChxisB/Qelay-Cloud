# A worker pool: the SDK's Worker on Cloud Run, with no HTTP listener.
#
# - A worker pool is for pull workloads. It needs no $PORT, no health endpoint and no ingress: the container
#   pulls bells and runs jobs, and CPU is always allocated (there is no request to throttle between).
# - A pool does NOT autoscale by itself. manual_instance_count is a fixed number. Terraform sets it once, at
#   creation, to min_instances; after that it belongs to the autoscaler (../autoscaler) or to an operator
#   (`gcloud run worker-pools update NAME --instances=N`), and an apply does not undo it (the same rule as
#   the AWS workers' desired_count).
# - Cloud Run enforces no ceiling on a pool, so max_instances is not a limit Google applies. The connection
#   budget counts it, the autoscaler caps at it, and the plan check reads it from the `qcloud-max-instances`
#   label. Scaling a pool by hand past it breaks the budget.
# - Direct VPC egress reaches Cloud SQL's private IP. Only private ranges use it; Pub/Sub is reached
#   through Google's public endpoints.
# - SIGTERM gives the container a fixed 10 s on Cloud Run: see docs/limits.md section 6 for what to pass to
#   Worker.close().

locals {
  # Each secret file is mounted by itself in a directory of its own: Cloud Run forbids two volumes at one
  # path and a secret volume replaces whatever the directory held.
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

resource "google_cloud_run_v2_worker_pool" "worker" {
  name                = var.name
  location            = var.region
  deletion_protection = false
  labels              = merge(var.labels, { "qcloud-max-instances" = tostring(var.max_instances) })

  template {
    service_account = var.service_account_email

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
      args    = var.args

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      env {
        name  = "QCLOUD_DATABASE_POOL_SIZE"
        value = tostring(var.pool_size)
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

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.min_instances
  }

  lifecycle {
    # The autoscaler, or an operator, owns the count once the pool exists.
    ignore_changes = [scaling[0].manual_instance_count]

    precondition {
      condition     = var.max_instances >= var.min_instances
      error_message = "max_instances (${var.max_instances}) is below min_instances (${var.min_instances})."
    }
  }
}
