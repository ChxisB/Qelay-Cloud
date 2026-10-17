variable "name" {
  description = "Prefix of every resource name (the environment name)."
  type        = string
}

variable "region" {
  description = "The region, for the VPC endpoints' service names (com.amazonaws.<region>.<service>)."
  type        = string
}

variable "vpc_cidr" {
  description = "The VPC's range. Each availability zone gets a private subnet that is a sixteenth of it (and a public one of the same size when egress is \"nat\"). A /16 gives /20 subnets of 4,091 usable addresses; a /24 gives /28 subnets of 11."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 24
    error_message = "vpc_cidr must be a valid IPv4 range of /24 or larger."
  }
}

variable "availability_zones" {
  description = "The zones to spread the private subnets over. At least two: an RDS subnet group needs two, even for a single-AZ instance."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2 && length(distinct(var.availability_zones)) == length(var.availability_zones)
    error_message = "availability_zones needs at least two distinct zones."
  }
}

variable "egress" {
  description = <<-EOT
    How tasks reach the internet. "nat": public subnets, an internet gateway and a NAT gateway; tasks may pull images
    from any registry and call any AWS API. "none": no public subnets, no internet gateway, no NAT: tasks reach AWS only
    through the VPC endpoints, so interface_endpoints must carry everything a task calls (the example checks it).
  EOT
  type        = string
  default     = "nat"

  validation {
    condition     = contains(["nat", "none"], var.egress)
    error_message = "egress must be nat or none."
  }
}

variable "nat_per_az" {
  description = "One NAT gateway per zone instead of one for the VPC. A zone failure then cannot cut the other zones' egress, at the price of one more gateway (and its hourly charge) per zone."
  type        = bool
  default     = false
}

variable "interface_endpoints" {
  description = "AWS services reached through an interface endpoint (private DNS on): the short service name, as in com.amazonaws.<region>.<name>. Each costs an hourly charge per zone. The S3 gateway endpoint is always created and is free."
  type        = set(string)
  default     = ["sqs", "secretsmanager"]
}

variable "tags" {
  type    = map(string)
  default = {}
}
