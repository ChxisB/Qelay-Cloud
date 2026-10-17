variable "namespace" {
  description = "The environment's namespace: the QCLOUD_NAMESPACE every process uses. It is part of every queue name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{1,100}$", var.namespace))
    error_message = "namespace must be 1 to 100 letters, digits and dashes. The transport encodes any other character as _xx, and this module writes the names without that encoding."
  }
}

variable "queues" {
  description = <<-EOT
    The queues that get a doorbell path, by name. Adding a queue here is the only way it gets one: the transport
    never creates a queue, so a worker or a bell for a queue that is not listed fails with "queue does not exist".
    The settings are the ones packages/transport-aws/src/provision.ts (ensureQueue) uses, and its defaults.
  EOT
  type = map(object({
    visibility_timeout_seconds    = optional(number, 30)
    max_receive_count             = optional(number, 5)
    retention_seconds             = optional(number, 345600)
    dead_letter_retention_seconds = optional(number, 1209600)
  }))

  validation {
    condition     = alltrue([for name in keys(var.queues) : can(regex("^[A-Za-z0-9-]{1,100}$", name))])
    error_message = "A queue name must be 1 to 100 letters, digits and dashes. The transport writes any other character as _xx, which this module does not reproduce: such a queue is created by the SDK's provisioning helper, not here."
  }

  validation {
    condition = alltrue([
      for queue in values(var.queues) :
      queue.visibility_timeout_seconds >= 0 && queue.visibility_timeout_seconds <= 43200
    ])
    error_message = "visibility_timeout_seconds must be 0 to 43200 (SQS's limit)."
  }

  validation {
    condition = alltrue([
      for queue in values(var.queues) :
      queue.max_receive_count >= 1 && queue.max_receive_count <= 1000
    ])
    error_message = "max_receive_count must be 1 to 1000 (SQS's limit)."
  }

  validation {
    condition = alltrue([
      for queue in values(var.queues) :
      queue.retention_seconds >= 60 && queue.retention_seconds <= 1209600 &&
      queue.dead_letter_retention_seconds >= 60 && queue.dead_letter_retention_seconds <= 1209600
    ])
    error_message = "Retention must be 60 seconds to 14 days (1209600), for the queue and for its dead-letter queue."
  }
}

variable "account_id" {
  description = "The AWS account id. A variable, not a lookup, so a plan needs no credentials: it makes every queue ARN known before the queue exists."
  type        = string
}

variable "region" {
  type = string
}

variable "partition" {
  type    = string
  default = "aws"
}

variable "kms_key_arn" {
  description = "An existing customer-managed key for the queues. Null creates one (rotation on) for this environment. Ignored when encryption is \"sqs-managed\"."
  type        = string
  default     = null
}

variable "encryption" {
  description = "\"kms\": the queues are encrypted with a customer-managed key; every producer and consumer needs kms:GenerateDataKey and kms:Decrypt on it (the iam module grants them). \"sqs-managed\": SQS's own key; no KMS charge and no key policy, and the key's use cannot be audited or restricted."
  type        = string
  default     = "kms"

  validation {
    condition     = contains(["kms", "sqs-managed"], var.encryption)
    error_message = "encryption must be kms or sqs-managed."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
