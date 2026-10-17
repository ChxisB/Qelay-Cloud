variable "max_connections" {
  description = "The database's max_connections flag: the ceiling every process shares."
  type        = number

  validation {
    condition     = var.max_connections >= 10 && floor(var.max_connections) == var.max_connections
    error_message = "max_connections must be a whole number of at least 10."
  }
}

variable "services" {
  description = <<-EOT
    Every service that opens database connections, keyed by name (a Cloud Run service, an ECS service). A service that can scale to
    max_instances opens up to max_instances x (pool_size + listen_connections) connections: the worker's
    concurrency is not in the figure, because a process's pool is shared by all its jobs.
  EOT
  type = map(object({
    max_instances      = number
    pool_size          = number
    listen_connections = number
  }))
  default = {}
}

variable "control_processes" {
  description = "Processes that are not worker services but hold a pool: the tick, the control API and the panel. The tick service is fixed at one instance and is one of these."
  type        = number
  default     = 3
}

variable "control_pool_size" {
  description = "Pool size of each control process."
  type        = number
  default     = 2
}

variable "reserved_connections" {
  description = "Connections kept for operators, migrations and the managed database's own maintenance."
  type        = number
  default     = 6
}

variable "pooled" {
  description = "Workers connect through a transaction pooler, so the database sees the pooler's server pool, not one pool per process."
  type        = bool
  default     = false
}

variable "pooler_server_pool_size" {
  description = "Server connections the pooler opens to the database (PgBouncer's default_pool_size, per database and user)."
  type        = number
  default     = 20
}

variable "warn_above" {
  description = "Fraction of max_connections above which a plan warns that a pooler is due."
  type        = number
  default     = 0.8
}
