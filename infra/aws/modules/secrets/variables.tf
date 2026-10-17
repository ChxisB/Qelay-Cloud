variable "name" {
  description = "Prefix of every secret's name: <name>/<key>."
  type        = string
}

variable "secret_names" {
  description = "The secrets to create, by key. Separate from secret_values so the keys are known at plan time while the values (which hold the password) may not be."
  type        = set(string)
}

variable "secret_values" {
  description = "Key => the secret's value. Every key of secret_names has one."
  type        = map(string)
  sensitive   = true
}

variable "recovery_window_in_days" {
  description = "Days a deleted secret can still be restored, 7 to 30; 0 deletes at once. Zero is for a teardown that will be re-applied under the same names."
  type        = number
  default     = 7

  validation {
    condition     = var.recovery_window_in_days == 0 || (var.recovery_window_in_days >= 7 && var.recovery_window_in_days <= 30)
    error_message = "recovery_window_in_days must be 0, or 7 to 30."
  }
}

variable "kms_key_arn" {
  description = "A customer-managed key for the secrets. Null uses the AWS-managed key aws/secretsmanager, which needs no grant in the roles that read them."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
