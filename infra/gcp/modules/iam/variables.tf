variable "name" {
  description = "Prefix of every service account id (the environment name). A service account id is 6 to 30 characters, so the name is at most 20."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2 to 20 characters: a lowercase letter, then lowercase letters, digits and dashes."
  }
}

variable "topic_name" {
  description = "The doorbell topic, which the workers and the tick publish to."
  type        = string
}

variable "subscription_names" {
  description = "Queue name => subscription id. The workers may pull from these and from no other."
  type        = map(string)
}

variable "secret_ids" {
  description = "Secret id suffix => the secret's resource id."
  type        = map(string)
}

variable "worker_secrets" {
  description = "The suffixes of the secrets the workers read."
  type        = set(string)
}

variable "tick_secrets" {
  description = "The suffixes of the secrets the tick reads."
  type        = set(string)
}

variable "deployer_members" {
  description = "Who runs Terraform, as IAM members (user:..., serviceAccount:...). Each gets iam.serviceAccountUser on the three service accounts below and nowhere else: creating a Cloud Run service or a scheduler job that runs as an account needs it."
  type        = set(string)
  default     = []
}
