variable "name" {
  description = "Prefix of every resource name: the instance is <name>-pg."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  description = "The proxy's outbound rule to the database is scoped to the VPC."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets in at least two zones, for the subnet group."
  type        = list(string)
}

variable "client_security_group_ids" {
  description = "Groups that may open connections to the database (or, with the proxy, to the proxy): the tasks' group."
  type        = list(string)
}

variable "engine_version" {
  description = "PostgreSQL version. \"18\" lets RDS pick the newest minor; auto_minor_version_upgrade then keeps it current in the maintenance window."
  type        = string
  default     = "18"
}

variable "instance_class" {
  description = "RDS instance class. db.t4g.small (2 vCPU burstable, 2 GiB) is the smallest this configuration's 100 connections fit comfortably; a micro (1 GiB) has less memory than 100 connections can use. The database is the cost floor of the environment."
  type        = string
  default     = "db.t4g.small"
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling. 0 turns autoscaling off."
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "A synchronous standby in a second zone, at about double the instance cost. Off: a zone failure restores from the latest backup (point in time, to within five minutes)."
  type        = bool
  default     = false
}

variable "cluster" {
  description = <<-EOT
    A Multi-AZ DB cluster (one writer and two readable standbys in three zones) in place of the single instance. Null:
    the instance, with multi_az for one standby. The size is allocated_storage_gb, with no storage autoscaling; the port is fixed; no proxy. `instance_class`,
    `storage_type` and `iops` have no default: take them from the supported list for your region and engine version.
  EOT
  type = object({
    instance_class = string
    storage_type   = string
    iops           = number
  })
  default = null
}

variable "max_connections" {
  description = "max_connections, set in the parameter group. It is a static parameter: a change applies at the next reboot, not at the apply."
  type        = number
}

variable "deletion_protection" {
  description = "Deletion protection on the instance, in Terraform and in the API. Leave on; the README's teardown says how to turn it off on purpose."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Automated backups and point-in-time recovery. 1 to 35; zero would turn backups off, which this module does not allow."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 1 to 35."
  }
}

variable "backup_window" {
  description = "UTC, hh:mm-hh:mm, at least 30 minutes."
  type        = string
  default     = "03:00-04:00"
}

variable "maintenance_window" {
  description = "UTC, ddd:hh:mm-ddd:hh:mm."
  type        = string
  default     = "sun:04:30-sun:05:30"
}

variable "storage_kms_key_arn" {
  description = "A customer-managed key for the storage. Null uses the AWS-managed key aws/rds. Storage is encrypted either way."
  type        = string
  default     = null
}

variable "ca_cert_identifier" {
  description = "The server certificate's authority. The CA bundle a client verifies with must contain it (the RDS global bundle does)."
  type        = string
  default     = "rds-ca-rsa2048-g1"
}

variable "performance_insights" {
  description = "Performance Insights (7 days of history is free). Off by default: it is not offered on every burstable class, and an unsupported class fails at apply, not at plan."
  type        = bool
  default     = false
}

variable "database_name" {
  type    = string
  default = "qcloud"
}

variable "user_name" {
  type    = string
  default = "qcloud"
}

variable "proxy" {
  description = <<-EOT
    An RDS Proxy in front of the instance, in transaction pooling mode. Null: none. The processes then connect to the
    proxy (QCLOUD_DATABASE_POOLER=transaction: prepared statements off), and a separate direct URL goes to
    QCLOUD_DATABASE_LISTEN_URL. The proxy does not support session-level advisory locks or LISTEN/NOTIFY on its
    connections, and pins a client to one server connection for as long as it uses one of them (docs/spikes/
    05-db-access-and-delay.md). max_connections_percent is the share of max_connections the proxy may open.
  EOT
  type = object({
    max_connections_percent      = optional(number, 50)
    max_idle_connections_percent = optional(number, 25)
    idle_client_timeout_seconds  = optional(number, 1800)
    borrow_timeout_seconds       = optional(number, 30)
  })
  default = null
}

variable "secrets_kms_key_arn" {
  description = "The key that encrypts the proxy's credential secret, if customer-managed. Null: the AWS-managed key aws/secretsmanager, whose ARN is not known to a plan, so the proxy's decrypt grant is by service condition on the account's keys."
  type        = string
  default     = null
}

variable "region" {
  type = string
}

variable "partition" {
  type    = string
  default = "aws"
}

variable "account_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
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
