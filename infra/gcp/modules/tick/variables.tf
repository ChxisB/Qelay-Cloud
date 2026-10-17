variable "name" {
  description = "The Cloud Run service's name. It is part of the URL, and so of the OIDC audience."
  type        = string
}

variable "region" {
  type = string
}

variable "project_number" {
  description = "The project's number. Cloud Run's deterministic URL, https://<name>-<project_number>.<region>.run.app, is the OIDC audience the scheduler signs for and the tick checks, so both can be set before the service exists."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{6,20}$", var.project_number))
    error_message = "project_number is the numeric project number: gcloud projects describe PROJECT_ID --format='value(projectNumber)'."
  }
}

variable "image" {
  description = "The tick container image. The Control API's image (packages/control-api/Dockerfile) carries the tick too: set `command` so it starts the tick and not the API."
  type        = string
}

variable "command" {
  description = "Overrides the image's entrypoint. Null runs the image as built. With the Control API's image, [\"bun\", \"/app/packages/maintenance/src/bin.ts\"] runs `qcloud-tick serve` (the module passes `serve` as the argument)."
  type        = list(string)
  default     = null
}

variable "service_account_email" {
  description = "The tick's identity, from the iam module."
  type        = string
}

variable "scheduler_service_account_email" {
  description = "The only identity that may call the tick: the scheduler's. Granted run.invoker on this service, and named in QCLOUD_TICK_ALLOWED_EMAILS."
  type        = string
}

variable "pool_size" {
  description = "Database connections the instance holds. The tick is fixed at one instance, which the budget counts among its control processes."
  type        = number
  default     = 2

  validation {
    condition     = var.pool_size >= 1 && floor(var.pool_size) == var.pool_size
    error_message = "pool_size must be a whole number, 1 or more."
  }
}

variable "cpu" {
  type    = string
  default = "1"
}

variable "memory" {
  type    = string
  default = "512Mi"
}

variable "network" {
  type = string
}

variable "subnetwork" {
  type = string
}

variable "env" {
  type    = map(string)
  default = {}
}

variable "secret_env" {
  type = map(object({
    secret_id = string
    version   = string
  }))
  default = {}
}

variable "secret_files" {
  type = map(object({
    secret_id = string
    version   = string
  }))
  default = {}
}

variable "labels" {
  type    = map(string)
  default = {}
}
