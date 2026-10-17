variable "namespace" {
  description = "The environment's namespace: the QCLOUD_NAMESPACE every process uses. It is part of every topic and subscription id."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{1,100}$", var.namespace))
    error_message = "namespace must be 1 to 100 letters, digits and dashes. The transport encodes any other character, and this module writes the names without that encoding."
  }
}

variable "queues" {
  description = <<-EOT
    The queues that get a doorbell path, by name. Adding a queue here is the only way it gets one: the SDK
    never creates a subscription, so a bell for a queue that is not listed is refused at the broker and a
    worker for it fails to start.
  EOT
  type = map(object({
    ack_deadline_seconds  = optional(number, 30)
    max_delivery_attempts = optional(number, 5)
    min_backoff_seconds   = optional(number, 1)
    max_backoff_seconds   = optional(number, 10)
  }))

  validation {
    condition     = alltrue([for name in keys(var.queues) : can(regex("^[A-Za-z0-9-]{1,100}$", name))])
    error_message = "A queue name must be 1 to 100 letters, digits and dashes. The transport writes any other character as _xx, which this module does not reproduce: such a queue is created by the SDK's provisioning helper, not here."
  }

  validation {
    condition = alltrue([
      for queue in values(var.queues) :
      queue.ack_deadline_seconds >= 10 && queue.ack_deadline_seconds <= 600
    ])
    error_message = "ack_deadline_seconds must be 10 to 600."
  }

  validation {
    condition = alltrue([
      for queue in values(var.queues) :
      queue.max_delivery_attempts >= 5 && queue.max_delivery_attempts <= 100
    ])
    error_message = "max_delivery_attempts must be 5 to 100 (Pub/Sub's own range for a dead-letter policy)."
  }

  validation {
    condition = alltrue([
      for queue in values(var.queues) :
      queue.min_backoff_seconds >= 0 && queue.max_backoff_seconds <= 600 && queue.min_backoff_seconds <= queue.max_backoff_seconds
    ])
    error_message = "Backoff must satisfy 0 <= min_backoff_seconds <= max_backoff_seconds <= 600."
  }
}

variable "project_number" {
  description = "The project's number (not its id), for the Pub/Sub service agent that forwards dead letters."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{6,20}$", var.project_number))
    error_message = "project_number is the numeric project number: gcloud projects describe PROJECT_ID --format='value(projectNumber)'."
  }
}

variable "message_retention_days" {
  description = "How long an unacknowledged bell, and a dead letter, is kept: 1 to 31 days."
  type        = number
  default     = 7
}

variable "labels" {
  type    = map(string)
  default = {}
}
