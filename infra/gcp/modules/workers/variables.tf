variable "name" {
  description = "The Cloud Run worker pool's name."
  type        = string
}

variable "region" {
  type = string
}

variable "image" {
  description = "The worker container image. It is the application's own (the repository's Dockerfiles are for the Control API and the panel; docs/runbooks/deploy-gcp.md sketches a worker image): a worker pool needs no listener and no $PORT. It reads the QCLOUD_* variables below."
  type        = string
}

variable "service_account_email" {
  description = "The workers' identity, from the iam module."
  type        = string
}

variable "min_instances" {
  description = "The instance count the pool is created with, and the autoscaler's floor when one is on (../autoscaler). A pool does not scale by itself, so without an autoscaler this is the whole fleet until an operator changes it. 1 or more keeps a worker always on: it then receives bells at once and may run the in-process tick, which is what gives second-level delay precision (docs/limits.md). 0 is a pool with no instance, and a job then waits until the autoscaler starts one."
  type        = number
  default     = 1

  validation {
    condition     = var.min_instances >= 0 && floor(var.min_instances) == var.min_instances
    error_message = "min_instances must be a whole number, 0 or more."
  }
}

variable "max_instances" {
  description = "Instances the pool may scale to. Required, with no default: an unbounded fleet has no connection budget (the budget module counts max_instances x pool_size). Cloud Run does not enforce it on a pool: the autoscaler caps at it, and the pool carries it as the qcloud-max-instances label."
  type        = number

  validation {
    condition     = var.max_instances >= 1 && floor(var.max_instances) == var.max_instances
    error_message = "max_instances must be a whole number, 1 or more."
  }
}

variable "pool_size" {
  description = "Database connections each instance holds (QCLOUD_DATABASE_POOL_SIZE). The budget counts it."
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
  description = "The VPC for Direct VPC egress."
  type        = string
}

variable "subnetwork" {
  description = "The subnet for Direct VPC egress. Each instance takes an address from it."
  type        = string
}

variable "env" {
  description = "Plain environment variables: the QCLOUD_* contract and anything of the application's own."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Environment variable => a secret and the version to read (a version number, not latest, so a changed secret rolls a revision)."
  type = map(object({
    secret_id = string
    version   = string
  }))
  default = {}
}

variable "secret_files" {
  description = "Mount path => a secret file, for what the process reads from disk (the database CA). Each is mounted alone in its own directory."
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
