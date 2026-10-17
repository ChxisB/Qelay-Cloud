# The Control API answering with server errors. The data plane's alerts (../modules/monitoring) cover the tick, the
# bells and the database; the API is created here, so its alert is too. Jobs keep running while the API is down, so this
# one is about operators losing sight, not about lost work. Cloud Run counts a request by its response class.

resource "google_monitoring_alert_policy" "api_errors" {
  count = var.alert_api_errors ? 1 : 0

  display_name          = "${var.name}: control API errors"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "The API answers with 5xx"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${local.api_name}\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.label.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.api_errors_per_second
      duration        = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The Control API has answered with server errors for five minutes. Workers and the tick do not depend on it; operators and the panel do.\n\nRunbook: ${var.runbook_base_url}/control-api-errors.md"
  }
}
