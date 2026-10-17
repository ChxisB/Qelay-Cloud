variable "name" {
  description = "Prefix of every resource name (the environment name)."
  type        = string
}

variable "region" {
  description = "Region of the subnet that Cloud Run's Direct VPC egress uses."
  type        = string
}

variable "subnet_cidr" {
  description = "Range of the workers' subnet. Direct VPC egress gives each Cloud Run instance an address from it, so size it for the largest max_instances of every service combined."
  type        = string
  default     = "10.10.0.0/24"
}

variable "private_services_prefix_length" {
  description = "Prefix length of the range reserved for Google-managed services (Cloud SQL's private IP)."
  type        = number
  default     = 20
}

variable "abandon_peering_on_destroy" {
  description = "On destroy, forget the private services connection instead of deleting it. Deleting it fails while the peering still carries a Cloud SQL instance that was only just deleted; abandoning lets the destroy finish, and the peering goes with the VPC or is removed by hand (README, teardown). Off by default: an abandoned peering is a leftover."
  type        = bool
  default     = false
}
