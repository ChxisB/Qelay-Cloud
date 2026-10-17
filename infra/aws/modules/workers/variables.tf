variable "name" {
  description = "The ECS service's name."
  type        = string
}

variable "region" {
  type = string
}

variable "image" {
  description = "The worker container image. It is the application's own (the repository's Dockerfiles are for the Control API and the panel): it runs a Qelay Worker and reads the QCLOUD_* variables below. A worker serves no port, so the service has no load balancer and no health check beyond the container staying up."
  type        = string
}

variable "command" {
  description = "Overrides the image's command. Null runs the image as built."
  type        = list(string)
  default     = null
}

variable "cluster_arn" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "task_role_arn" {
  description = "The workers' task role, from the iam module."
  type        = string
}

variable "execution_role_arn" {
  description = "The workers' execution role, from the iam module."
  type        = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "min_instances" {
  description = "Tasks kept running. 1 or more keeps a worker always on: it then receives bells at once and may run the in-process tick, which is what gives second-level delay precision (docs/limits.md). 0 stops the service, and a delayed job then waits for the scheduler's one-minute tick."
  type        = number
  default     = 1

  validation {
    condition     = var.min_instances >= 0 && floor(var.min_instances) == var.min_instances
    error_message = "min_instances must be a whole number, 0 or more."
  }
}

variable "max_instances" {
  description = "Tasks the service may scale to. Required, with no default: an unbounded service has no connection budget (the budget module counts max_instances x pool_size)."
  type        = number

  validation {
    condition     = var.max_instances >= 1 && floor(var.max_instances) == var.max_instances
    error_message = "max_instances must be a whole number, 1 or more."
  }
}

variable "pool_size" {
  description = "Database connections each task holds (QCLOUD_DATABASE_POOL_SIZE). The budget counts it."
  type        = number
  default     = 2

  validation {
    condition     = var.pool_size >= 1 && floor(var.pool_size) == var.pool_size
    error_message = "pool_size must be a whole number, 1 or more."
  }
}

variable "cpu" {
  description = "Fargate CPU units: 256, 512, 1024, 2048, 4096, 8192 or 16384."
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096, 8192, 16384], var.cpu)
    error_message = "cpu must be one of Fargate's sizes: 256, 512, 1024, 2048, 4096, 8192, 16384."
  }
}

variable "memory" {
  description = "Fargate memory in MiB. Only some pairs with cpu exist (512 MiB to 2 GiB at 256 cpu; 1 to 4 GiB at 512; 2 to 8 GiB at 1024); an invalid pair fails at apply."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64. The image must be built for it."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "env" {
  description = "Plain environment variables (QCLOUD_* settings: nothing secret)."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Environment variable => the Secrets Manager secret's ARN. ECS reads the value when a task starts, with the execution role."
  type        = map(string)
  default     = {}
}

variable "rollout_trigger" {
  description = "Any string whose change rolls the service: the secrets' version ids, so a new password reaches the tasks, which read their secrets only when they start."
  type        = string
  default     = ""
}

variable "log_group_name" {
  description = "The CloudWatch log group, created here. The execution role's write permission is on this name."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "spot" {
  description = "Run the tasks above min_instances on Fargate Spot, which costs less and can be taken back with two minutes' notice (SIGTERM, then stop_timeout_seconds). The first min_instances tasks stay on-demand. A taken task is a stalled job the stall check recovers; a worker that finishes its jobs inside stop_timeout_seconds loses nothing. Spot capacity can be missing: the service then waits for it, and the no-task alarm is for the on-demand floor only."
  type        = bool
  default     = false
}

variable "stop_timeout_seconds" {
  description = "How long ECS waits after SIGTERM before it kills the container, at most 120: a worker finishes the jobs it holds in that time or leaves them for the stall check."
  type        = number
  default     = 60

  validation {
    condition     = var.stop_timeout_seconds >= 2 && var.stop_timeout_seconds <= 120
    error_message = "stop_timeout_seconds must be 2 to 120 (Fargate's limit)."
  }
}

variable "deployment_minimum_healthy_percent" {
  description = "With maximum 100 and minimum 0 a rollover stops the old tasks before it starts the new ones, so the service never has more than max_instances tasks and the connection budget holds, at the price of a short gap in capacity (bells wait in the queue). Raise the maximum only after budgeting for the extra tasks."
  type        = number
  default     = 0
}

variable "deployment_maximum_percent" {
  type    = number
  default = 100
}

variable "autoscaling" {
  description = <<-EOT
    Scale on queue depth. Null: the service runs min_instances tasks and nothing changes that. When set, an alarm on the
    SQS queue's visible bells adds scale_out_step tasks while there are more than scale_out_above of them, and another
    removes scale_in_step while there are at most scale_in_below, never above max_instances or below min_instances.
    queue_name is the SQS queue's name (messaging's queue_names), not the Qelay queue's.
  EOT
  type = object({
    queue_name       = string
    scale_out_above  = optional(number, 100)
    scale_in_below   = optional(number, 10)
    scale_out_step   = optional(number, 2)
    scale_in_step    = optional(number, 1)
    cooldown_seconds = optional(number, 120)
  })
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
