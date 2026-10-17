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
  description = "ENTERPRISE or ENTERPRISE_PLUS. Managed connection pooling exists only on Enterprise Plus, which this module does not use."
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
