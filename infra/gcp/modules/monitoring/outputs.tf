output "alert_policy_ids" {
  description = "Policy => its id."
  value = merge(
    { for policy in google_monitoring_alert_policy.dead_letter_depth : "dead_letter_depth" => policy.id },
    { for policy in google_monitoring_alert_policy.backlog_age : "backlog_age" => policy.id },
    {
      database_connections = google_monitoring_alert_policy.database_connections.id
      scheduler_failures   = google_monitoring_alert_policy.scheduler_failures.id
      tick_absent          = google_monitoring_alert_policy.tick_absent.id
    },
    { for policy in google_monitoring_alert_policy.workers_idle_with_backlog : "workers_idle_with_backlog" => policy.id },
    { for policy in google_monitoring_alert_policy.claim_latency : "claim_latency" => policy.id },
    { for policy in google_monitoring_alert_policy.dead_letter_queue_growth : "dead_letter_queue_growth" => policy.id }
  )
}
