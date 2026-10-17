# The one-minute scheduler job: cron source and safety net. It stays on even where an always-on worker runs
# the in-process tick, because that tick lives and dies with its worker and this one does not.
#
# A missed or failed call is harmless: the tick is idempotent and the next minute makes it up. Retries are
# therefore off, so a slow tick is not called twice at once by the scheduler itself.

resource "google_cloud_scheduler_job" "tick" {
  name             = var.name
  region           = var.region
  schedule         = var.schedule
  time_zone        = var.time_zone
  attempt_deadline = var.attempt_deadline
  paused           = var.paused

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = var.tick_url

    oidc_token {
      service_account_email = var.service_account_email
      audience              = var.audience
    }
  }
}
