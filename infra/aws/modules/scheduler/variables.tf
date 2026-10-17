variable "name" {
  description = "The schedule's name. The scheduler role's trust policy names it."
  type        = string
}

variable "schedule_expression" {
  description = "How often the tick starts: rate(1 minute) is EventBridge Scheduler's finest grain. A longer period delays every delayed job, retry and cron by up to that long when no worker is running."
  type        = string
  default     = "rate(1 minute)"
}

variable "enabled" {
  description = "false creates the schedule paused, for a stack that is not yet to run the tick."
  type        = bool
  default     = true
}

variable "cluster_arn" {
  type = string
}

variable "task_definition_arn" {
  description = "The tick's task definition ARN without a revision."
  type        = string
}

variable "role_arn" {
  description = "The scheduler role (iam module): it may run the tick and pass the tick's two roles, nothing else."
  type        = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}
