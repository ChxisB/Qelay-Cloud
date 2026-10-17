variable "name" {
  description = "The task definition's family."
  type        = string
}

variable "region" {
  type = string
}

variable "image" {
  description = "The image that holds the tick CLI (packages/maintenance, bin qcloud-tick). The repository's Control API image carries it: set tick_command there."
  type        = string
}

variable "command" {
  description = "Overrides the image's ENTRYPOINT so that it runs the tick CLI, for an image whose entrypoint is something else (the Control API's). Null keeps the image's own. The container's command is always [\"run\"]: one invocation of the tick, then exit."
  type        = list(string)
  default     = null
}

variable "task_role_arn" {
  type = string
}

variable "execution_role_arn" {
  type = string
}

variable "cpu" {
  description = "Fargate CPU units. The tick is short and light."
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.cpu)
    error_message = "cpu must be one of Fargate's sizes: 256, 512, 1024, 2048, 4096."
  }
}

variable "memory" {
  description = "Fargate memory in MiB (512 is the smallest that pairs with 256 cpu)."
  type        = number
  default     = 512
}

variable "cpu_architecture" {
  type    = string
  default = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "pool_size" {
  description = "Database connections one tick holds (QCLOUD_DATABASE_POOL_SIZE). The budget counts every tick that may overlap."
  type        = number
  default     = 2

  validation {
    condition     = var.pool_size >= 1 && floor(var.pool_size) == var.pool_size
    error_message = "pool_size must be a whole number, 1 or more."
  }
}

variable "env" {
  description = "Plain environment variables (QCLOUD_* settings: nothing secret)."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Environment variable => the Secrets Manager secret's ARN, read by the execution role when the task starts."
  type        = map(string)
  default     = {}
}

variable "max_run_ms" {
  description = "QCLOUD_TICK_MAX_RUN_MS: how long one tick may run. It must stay well under the schedule's period, so that ticks do not pile up."
  type        = number
  default     = 20000
}

variable "log_group_name" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
