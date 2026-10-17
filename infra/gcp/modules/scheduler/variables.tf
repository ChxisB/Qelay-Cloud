variable "name" {
  description = "The job's name."
  type        = string
}

variable "region" {
  type = string
}

variable "tick_url" {
  description = "The tick endpoint, from the tick module."
  type        = string
}

variable "audience" {
  description = "The OIDC audience, from the tick module."
  type        = string
}

variable "service_account_email" {
  description = "The identity the job signs as: the scheduler's, from the iam module. It holds run.invoker on the tick service and no other role."
  type        = string
}

variable "schedule" {
  description = "A cron expression. Every minute is Cloud Scheduler's finest grain, and the floor of delay precision without an always-on worker."
  type        = string
  default     = "* * * * *"
}

variable "time_zone" {
  type    = string
  default = "Etc/UTC"
}

variable "attempt_deadline" {
  description = "How long one call may take. The tick's own budget (QCLOUD_TICK_MAX_RUN_MS) should be shorter."
  type        = string
  default     = "120s"
}

variable "paused" {
  description = "Create the job paused. A paused job stops the tick, so recovery, cron and promotion stop with it."
  type        = bool
  default     = false
}
