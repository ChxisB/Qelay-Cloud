variable "name" {
  description = "Prefix of the autoscaler's resource names (the environment name). A service account id is 6 to 30 characters, so the name is at most 20."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2 to 20 characters: a lowercase letter, then lowercase letters, digits and dashes."
  }
}

variable "project_id" {
  type = string
}

variable "region" {
  description = "Where the autoscaler and the worker pools run. The config parameter is global."
  type        = string
}

variable "image" {
  description = "The CREMA image (Google's, built on KEDA). Pin a tag you have read the release notes of, or a digest. Images published before 29 April 2026 had memory leaks, so do not go back to one."
  type        = string
  default     = "us-central1-docker.pkg.dev/cloud-run-oss-images/crema-v1/autoscaler:1.3"
}

variable "polling_interval_seconds" {
  description = "How often the autoscaler reads each subscription's backlog and sets the count. Cloud Monitoring samples the backlog every 60 s, so less than 30 only costs API quota."
  type        = number
  default     = 30

  validation {
    condition     = var.polling_interval_seconds >= 15 && floor(var.polling_interval_seconds) == var.polling_interval_seconds
    error_message = "polling_interval_seconds must be a whole number, 15 or more."
  }
}

variable "targets" {
  description = "Worker pool name => what it follows: the queue's subscription (its name, not its resource path), the pool's floor and ceiling, and how many un-acked bells one instance is expected to carry."
  type = map(object({
    subscription         = string
    min_instances        = number
    max_instances        = number
    backlog_per_instance = number
  }))

  validation {
    condition     = alltrue([for t in values(var.targets) : t.max_instances >= t.min_instances && t.min_instances >= 0 && t.backlog_per_instance >= 1])
    error_message = "Every target needs max_instances >= min_instances >= 0 and backlog_per_instance >= 1."
  }
}

variable "workers_service_account_email" {
  description = "The workers' service account: the autoscaler acts as it when it changes a pool."
  type        = string
}

variable "labels" {
  type    = map(string)
  default = {}
}
