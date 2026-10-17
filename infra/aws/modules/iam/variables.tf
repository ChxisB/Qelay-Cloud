variable "name" {
  description = "Prefix of every role's name. 2 to 20 characters (the longest role name adds 15)."
  type        = string
}

variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

variable "partition" {
  type    = string
  default = "aws"
}

variable "queue_arns" {
  description = "Qelay queue => the SQS queue's ARN, from the messaging module."
  type        = map(string)
}

variable "queue_urls" {
  description = "Qelay queue => the SQS queue's URL: where the queue policy is attached."
  type        = map(string)
}

variable "dead_letter_arns" {
  type = map(string)
}

variable "dead_letter_urls" {
  type = map(string)
}

variable "queue_key_enabled" {
  description = "True when the queues are encrypted with a customer-managed key, which the roles then need a grant on. A separate flag from the key's ARN, because the ARN of a key this configuration creates is unknown until apply and a resource count cannot depend on it."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "The key the queues are encrypted with: the grant's resource. Ignored when queue_key_enabled is false."
  type        = string
  default     = null
}

variable "worker_secret_names" {
  description = "The secrets the workers' tasks read, by key => the secret's name (not its ARN, which has a random suffix)."
  type        = map(string)
}

variable "tick_secret_names" {
  description = "The secrets the tick's tasks read, by key => the secret's name."
  type        = map(string)
}

variable "secrets_kms_key_arn" {
  description = "The customer-managed key the secrets are encrypted with. Null: the AWS-managed key, which needs no grant."
  type        = string
  default     = null
}

variable "image_repository_arns" {
  description = "The ECR repositories the task images are pulled from. Empty: the execution roles get no ECR layer access, for images in a registry that is not ECR."
  type        = list(string)
  default     = []
}

variable "cluster_name" {
  description = "The ECS cluster the tick runs in: the scheduler may run tasks there and nowhere else."
  type        = string
}

variable "workers_log_groups" {
  description = "The log groups of the worker services: the workers' execution role may write to these and no others."
  type        = list(string)
}

variable "tick_log_group" {
  type = string
}

variable "tick_family" {
  description = "The tick task definition's family: the scheduler may run this family and no other."
  type        = string
}

variable "schedule_name" {
  description = "The schedule's name, for the scheduler role's trust condition."
  type        = string
}

variable "additional_principal_arns" {
  description = "Roles other than the tasks' that may use the queues: the control plane's task role (task 43), an operator's role. They keep the access their own policies give them; the queue policies stop denying them."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
