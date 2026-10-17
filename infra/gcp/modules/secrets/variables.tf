variable "name" {
  description = "Prefix of every secret id (the environment name)."
  type        = string
}

variable "secret_names" {
  description = "The secrets to create, by id suffix. Known at plan time: it is the for_each key."
  type        = set(string)
}

variable "secret_values" {
  description = "The value of each secret, by id suffix. Every name in secret_names needs one. The values are in the Terraform state."
  type        = map(string)
  sensitive   = true
}

variable "labels" {
  type    = map(string)
  default = {}
}
