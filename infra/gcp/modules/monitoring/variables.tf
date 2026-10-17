variable "name" {
  description = "Prefix of every alert policy's display name."
  type        = string
}

variable "project_id" {
  description = "The project id: the database's resource label is project:instance."
  type        = string
}

variable "dead_letter_subscription_names" {
  description = "The dead-letter subscriptions' ids, from the messaging module."
  type        = list(string)
}

variable "subscription_names" {
  description = "The queue subscriptions' ids, from the messaging module."
  type        = list(string)
}

variable "database_instance_name" {
  description = "The Cloud SQL instance's name."
  type        = string
}

variable "max_connections" {
  description = "The database's max_connections, for the connection alert."
  type        = number
}

variable "scheduler_job_name" {
  description = "The scheduler job whose failures are alerted."
  type        = string
}

variable "notification_channels" {
  description = "Notification channel ids (projects/<project>/notificationChannels/<id>). Empty: the policies exist and show incidents in the console but notify nobody."
  type        = list(string)
  default     = []
}

variable "dead_letter_depth_threshold" {
  description = "Alert when a dead-letter subscription holds more than this many messages. A bell reaches the dead-letter topic only after its subscription's max_delivery_attempts failed deliveries, so any are worth a look. This is the dead-letter depth input of task 71."
  type        = number
  default     = 0
}

variable "oldest_unacked_seconds" {
  description = "Alert when a queue subscription's oldest unacknowledged bell is older than this. It means workers are not pulling, or cannot keep up."
  type        = number
  default     = 600
}

variable "connection_alert_fraction" {
  description = "Alert when the database's open connections exceed this fraction of max_connections."
  type        = number
  default     = 0.8
}

variable "runbook_base_url" {
  description = "Where the runbooks are published, without a trailing slash. Every alert's documentation ends with a link to its runbook under this address. The default is the path in the repository."
  type        = string
  default     = "docs/runbooks"
}

variable "tick_missed_seconds" {
  description = "Alert when the scheduler job has made no attempt for this long. It should be a few times the schedule."
  type        = number
  default     = 900
}

variable "worker_pool_names" {
  description = "The worker Cloud Run worker pools. Empty: no alert for a backlog with no worker running."
  type        = list(string)
  default     = []
}

variable "claim_latency_metric_type" {
  description = "The Cloud Monitoring metric type your pipeline gives qcloud.worker.claim_ms (a distribution, in milliseconds). Empty: no claim latency alert. See docs/observability.md."
  type        = string
  default     = ""
}

variable "claim_latency_p99_ms" {
  description = "Alert when the 99th percentile of a claim is slower than this."
  type        = number
  default     = 1000
}

variable "failed_total_metric_type" {
  description = "The metric type your pipeline gives qcloud.tick.jobs.failed_total (a gauge). Empty: no dead-letter growth alert. The shipped tick image does not export it. See docs/observability.md."
  type        = string
  default     = ""
}

variable "dlq_growth_per_window" {
  description = "Alert when more than this many jobs reached the dead-letter queue within the window."
  type        = number
  default     = 10
}

variable "dlq_growth_window_seconds" {
  description = "The window of the dead-letter growth alert."
  type        = number
  default     = 300
}
