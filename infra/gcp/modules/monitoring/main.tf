# Alert policies. They are policies, not a dashboard: each says what is wrong, links its runbook, and notifies the
# channels passed in. The thresholds are defaults chosen before any traffic: tune them after a week of real data.
# None of these has been seen to fire on a real project (docs/runbooks/README.md says which ones were exercised).

locals {
  runbook            = { for name in ["tick-stopped", "doorbells-piling-up", "transport-dead-letters", "connection-exhaustion", "dead-letter-queue-growing", "slow-claims"] : name => "Runbook: ${var.runbook_base_url}/${name}.md" }
  dead_letter_filter = "resource.type=\"pubsub_subscription\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.label.subscription_id=one_of(${join(",", [for id in var.dead_letter_subscription_names : "\"${id}\""])})"
  backlog_filter     = "resource.type=\"pubsub_subscription\" AND metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.label.subscription_id=one_of(${join(",", [for id in var.subscription_names : "\"${id}\""])})"
}

resource "google_monitoring_alert_policy" "dead_letter_depth" {
  count = length(var.dead_letter_subscription_names) > 0 ? 1 : 0

  display_name          = "${var.name}: dead-letter bells"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "A dead-letter subscription holds bells"
    condition_threshold {
      filter          = local.dead_letter_filter
      comparison      = "COMPARISON_GT"
      threshold_value = var.dead_letter_depth_threshold
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "A bell failed delivery its subscription's maximum number of times and was dead-lettered. The job it announced is in Postgres, and the tick re-rings it, so no work is lost; the cause is a worker that cannot ack (crashing, or starved of database connections). Check the worker service's logs and the connection alert.\n\n${local.runbook["transport-dead-letters"]}"
  }
}

resource "google_monitoring_alert_policy" "backlog_age" {
  count = length(var.subscription_names) > 0 ? 1 : 0

  display_name          = "${var.name}: bells waiting"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "The oldest unacknowledged bell is old"
    condition_threshold {
      filter          = local.backlog_filter
      comparison      = "COMPARISON_GT"
      threshold_value = var.oldest_unacked_seconds
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Bells have waited longer than the threshold. Workers are not pulling (none running, all at their concurrency, or unable to reach the database) or cannot keep up. A bell is a doorbell: the jobs are safe in Postgres, and the tick re-rings them.\n\n${local.runbook["doorbells-piling-up"]}"
  }
}

resource "google_monitoring_alert_policy" "database_connections" {
  display_name          = "${var.name}: database connections"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "Open connections are close to max_connections"
    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${var.database_instance_name}\" AND metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\""
      comparison      = "COMPARISON_GT"
      threshold_value = floor(var.max_connections * var.connection_alert_fraction)
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The database has more open connections than the budget allows for. Past max_connections a connection attempt fails with SQLSTATE 53300, so a worker that cannot connect cannot claim. Lower max_instances or pool_size, raise the tier, or put a transaction pooler in front (see the README's connection budget).\n\n${local.runbook["connection-exhaustion"]}"
  }
}

resource "google_monitoring_alert_policy" "scheduler_failures" {
  display_name          = "${var.name}: tick calls failing"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "The scheduler job logged errors"
    condition_threshold {
      filter          = "resource.type=\"cloud_scheduler_job\" AND resource.label.job_id=\"${var.scheduler_job_name}\" AND metric.type=\"logging.googleapis.com/log_entry_count\" AND metric.label.severity=\"ERROR\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "More than two calls to the tick failed in five minutes. While the tick is down, lost bells are not re-rung, a crashed worker's jobs are not recovered, cron jobs do not fire and delayed jobs are not promoted. A 401 means the OIDC audience or the allowed email is wrong; a 500 means the tick itself failed (see its logs).\n\n${local.runbook["tick-stopped"]}"
  }
}

# A tick that was switched off, or a scheduler job that was paused or deleted, logs no errors: it logs nothing.
# Cloud Scheduler writes a log entry for each attempt, so no entries for tick_missed_seconds means no ticks.
# An absence condition only watches a series that existed in the last 24 hours.
resource "google_monitoring_alert_policy" "tick_absent" {
  display_name          = "${var.name}: tick not running"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "The scheduler job has logged no attempt"
    condition_absent {
      filter   = "resource.type=\"cloud_scheduler_job\" AND resource.label.job_id=\"${var.scheduler_job_name}\" AND metric.type=\"logging.googleapis.com/log_entry_count\""
      duration = "${var.tick_missed_seconds}s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The scheduler job that calls the tick has made no attempt for ${var.tick_missed_seconds} seconds: it is paused, deleted or disabled. Until it runs again, lost bells are not re-rung, a crashed worker's jobs are not recovered, cron jobs do not fire and delayed jobs are not promoted. Workers keep claiming the jobs that are already ringing.\n\n${local.runbook["tick-stopped"]}"
  }
}

# Jobs are waiting and no worker instance exists. A worker pool with no instance reports no
# instance_count series, so missing data counts as the condition being met.
resource "google_monitoring_alert_policy" "workers_idle_with_backlog" {
  count = length(var.subscription_names) > 0 && length(var.worker_pool_names) > 0 ? 1 : 0

  display_name          = "${var.name}: bells waiting and no worker running"
  combiner              = "AND"
  notification_channels = var.notification_channels

  conditions {
    display_name = "The oldest unacknowledged bell is old"
    condition_threshold {
      filter          = local.backlog_filter
      comparison      = "COMPARISON_GT"
      threshold_value = var.oldest_unacked_seconds
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "No worker instance is running"
    condition_threshold {
      filter                  = "resource.type=\"cloud_run_worker_pool\" AND metric.type=\"run.googleapis.com/container/instance_count\" AND resource.label.worker_pool_name=one_of(${join(",", [for id in var.worker_pool_names : "\"${id}\""])})"
      comparison              = "COMPARISON_LT"
      threshold_value         = 1
      duration                = "300s"
      evaluation_missing_data = "EVALUATION_MISSING_DATA_ACTIVE"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Bells are waiting and no worker instance is running. Nothing is lost: the jobs are in Postgres. Check that the worker pool has an instance count above 0 (a pool does not scale by itself: see the autoscaler), that the last revision is ready, and that its image and secrets resolve.\n\n${local.runbook["doorbells-piling-up"]}"
  }
}

# --- opt-in: metrics the application exports itself ---------------------------------------------------------
# These two read metrics that exist only where the workers and the tick are run with the OpenTelemetry adapters
# of packages/telemetry and an export path to Cloud Monitoring (docs/observability.md). The shipped tick image does
# not export metrics, so jobs.failed_total has no source until you wire one. Pass the metric types your pipeline
# produces; leaving them empty creates nothing. Which names the pipeline gives them is not verified here.

resource "google_monitoring_alert_policy" "claim_latency" {
  count = var.claim_latency_metric_type == "" ? 0 : 1

  display_name          = "${var.name}: slow claims"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "The 99th percentile of a claim is slow"
    condition_threshold {
      filter          = "metric.type=\"${var.claim_latency_metric_type}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.claim_latency_p99_ms
      duration        = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Claims (the database round trip that takes the next job) take longer than ${var.claim_latency_p99_ms} ms at the 99th percentile. Jobs start late. The usual causes are a saturated database, a pool too small for the concurrency, or a long transaction holding locks.\n\n${local.runbook["slow-claims"]}"
  }
}

resource "google_monitoring_alert_policy" "dead_letter_queue_growth" {
  count = var.failed_total_metric_type == "" ? 0 : 1

  display_name          = "${var.name}: jobs failing for good"
  combiner              = "OR"
  notification_channels = var.notification_channels

  conditions {
    display_name = "Jobs are reaching the dead-letter queue"
    condition_threshold {
      filter          = "metric.type=\"${var.failed_total_metric_type}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.dlq_growth_per_window
      duration        = "0s"

      aggregations {
        alignment_period     = "${var.dlq_growth_window_seconds}s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "More than ${var.dlq_growth_per_window} jobs used their last attempt in ${var.dlq_growth_window_seconds} seconds and now sit in a queue's dead-letter list. They are kept, with their error, until they are retried or removed.\n\n${local.runbook["dead-letter-queue-growing"]}"
  }
}
