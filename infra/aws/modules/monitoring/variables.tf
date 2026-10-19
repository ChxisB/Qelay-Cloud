variable "name" {
  description = "Prefix of every alarm and of the CloudWatch namespace of the tick metric."
  type        = string
}

variable "queue_names" {
  description = "Qelay queue => the SQS queue's name (messaging's queue_names)."
  type        = map(string)
}

variable "dead_letter_names" {
  description = "Qelay queue => the dead-letter queue's name."
  type        = map(string)
}

variable "database_identifier" {
  type = string
}

variable "database_dimension" {
  description = "The CloudWatch dimension that names the database: DBInstanceIdentifier for an instance, DBClusterIdentifier for a Multi-AZ DB cluster (not verified against a real account: if the cluster's metrics sit under the member instances, the alarms report no data instead of firing)."
  type        = string
  default     = "DBInstanceIdentifier"

  validation {
    condition     = contains(["DBInstanceIdentifier", "DBClusterIdentifier"], var.database_dimension)
    error_message = "database_dimension is DBInstanceIdentifier or DBClusterIdentifier."
  }
}

variable "max_connections" {
  description = "The database's max_connections: the connection alarm fires at connection_alarm_ratio of it."
  type        = number
}

variable "database_storage_gb" {
  description = "The database's allocated storage, for the free-space alarm."
  type        = number
}

variable "database_instance_class" {
  description = "The RDS instance class. A burstable class (db.t*) gets an alarm for borrowed CPU credits; any other gets none."
  type        = string
  default     = null
}

variable "tick_log_group_name" {
  type = string
}

variable "tick_schedule_minutes" {
  description = "How often the tick is scheduled, in minutes. The tick alarm fires after tick_missed_minutes with no success."
  type        = number
  default     = 1
}

variable "tick_missed_minutes" {
  description = "Minutes without one successful tick before the alarm fires."
  type        = number
  default     = 5
}

variable "dead_letter_age_seconds" {
  description = "The dead-letter alarm's age threshold. A bell that dead-letters is a metric, not a job: the job it named is still in Postgres and the tick rings it again, so the depth says how often a bell failed, not that work is lost."
  type        = number
  default     = 3600
}

variable "queue_age_seconds" {
  description = "A bell waiting this long in a main queue means no worker is taking them."
  type        = number
  default     = 900
}

variable "connection_alarm_ratio" {
  type    = number
  default = 0.8
}

variable "alarm_actions" {
  description = "SNS topic ARNs (or other alarm actions) for every alarm. Empty: the alarms exist and show state, and notify nobody."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "runbook_base_url" {
  description = "Where the runbooks are published, without a trailing slash. Every alarm's description ends with a link to its runbook under this address. The default is the path in the repository."
  type        = string
  default     = "docs/runbooks"
}

variable "cluster_name" {
  description = "The ECS cluster of the worker services, for the no-worker alarm."
  type        = string
  default     = ""
}

variable "worker_service_names" {
  description = "The ECS worker services. Empty: no alarm for a backlog with no worker running."
  type        = list(string)
  default     = []
}

variable "claim_latency_metric" {
  description = "The CloudWatch metric your pipeline gives qcloud.worker.claim_ms (milliseconds). Null: no claim latency alarm. See docs/observability.md."
  type        = object({ namespace = string, name = string })
  default     = null
}

variable "claim_latency_p99_ms" {
  description = "Alarm when the 99th percentile of a claim is slower than this."
  type        = number
  default     = 1000
}

variable "failed_total_metric" {
  description = "The CloudWatch metric your pipeline gives qcloud.tick.jobs.failed_total (a gauge). Null: no dead-letter growth alarm. The shipped tick image does not export it. See docs/observability.md."
  type        = object({ namespace = string, name = string })
  default     = null
}

variable "dlq_growth_per_window" {
  description = "Alarm when more than this many jobs reach the dead-letter queue within the window (the rate of the failed total times the window), two windows running."
  type        = number
  default     = 10
}

variable "dlq_growth_window_seconds" {
  description = "The period of the dead-letter growth alarm."
  type        = number
  default     = 300
}
