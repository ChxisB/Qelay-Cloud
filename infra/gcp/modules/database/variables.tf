variable "name" {
  description = "Prefix of every resource name (the environment name)."
  type        = string
}

variable "region" {
  type = string
}

variable "network_id" {
  description = "The VPC for the private IP, from the network module (it waits for the peering)."
  type        = string
}

variable "tier" {
  description = "Machine tier. Default: 1 vCPU, 3.75 GB, the smallest dedicated-core tier. Shared-core tiers (db-f1-micro, db-g1-small) have no SLA and very few connections."
  type        = string
  default     = "db-custom-1-3840"
}

variable "edition" {
  description = "ENTERPRISE or ENTERPRISE_PLUS. Managed connection pooling exists only on Enterprise Plus, which also needs a db-perf-optimization tier."
  type        = string
  default     = "ENTERPRISE"
}

variable "high_availability" {
  description = "REGIONAL availability: a standby in another zone, at about double the instance cost. Off by default: a zonal instance restores from a backup after a zone failure."
  type        = bool
  default     = false
}

variable "max_connections" {
  description = "The max_connections flag. Checked against the connection budget by the budget module, which the caller passes through."
  type        = number
}

variable "disk_size_gb" {
  type    = number
  default = 10
}

variable "disk_type" {
  type    = string
  default = "PD_SSD"
}

variable "database_name" {
  type    = string
  default = "qcloud"
}

variable "user_name" {
  type    = string
  default = "qcloud"
}

variable "deletion_protection" {
  description = "Protects the instance from deletion through Terraform and through the API. Leave on; see the README's teardown."
  type        = bool
  default     = true
}

variable "backup_start_time" {
  description = "UTC start of the daily backup window, HH:MM."
  type        = string
  default     = "03:00"
}

variable "retained_backups" {
  type    = number
  default = 7
}

variable "transaction_log_retention_days" {
  description = "How far back point-in-time recovery reaches, 1 to 7."
  type        = number
  default     = 7
}

variable "maintenance_day" {
  description = "Day of the maintenance window, 1 (Monday) to 7 (Sunday)."
  type        = number
  default     = 7
}

variable "maintenance_hour" {
  description = "UTC hour of the maintenance window."
  type        = number
  default     = 4
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "managed_pooling" {
  description = "Cloud SQL's managed connection pooling (Enterprise Plus only). The pooler answers on the instance's private IP, port 6432, in transaction mode."
  type        = bool
  default     = false
}

variable "session_timeouts" {
  description = "Server-wide session limits in milliseconds, 0 = off. statement_ms bounds a statement the client gave up on (the SDK's own deadline retires the pool but cannot stop the server); lock_ms makes a statement that cannot get a lock give up instead of queueing everyone behind it; idle_in_transaction_ms ends a session that opened a transaction and went away. The migrator lifts statement_ms for itself, so a slow index build is bounded by its own deadline only. Behind a pooler these cannot be startup parameters, which is why they are set here, on the server."
  type = object({
    statement_ms           = optional(number, 30000)
    lock_ms                = optional(number, 5000)
    idle_in_transaction_ms = optional(number, 30000)
  })
  default = {}

  validation {
    condition     = alltrue([for v in values(var.session_timeouts) : v >= 0 && floor(v) == v])
    error_message = "session_timeouts values must be non-negative whole milliseconds (0 turns one off)."
  }
}
