output "workers_email" {
  value = google_service_account.workers.email
}

output "tick_email" {
  value = google_service_account.tick.email
}

output "scheduler_email" {
  value = google_service_account.scheduler.email
}
