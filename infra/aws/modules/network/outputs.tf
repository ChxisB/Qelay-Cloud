output "vpc_id" {
  value = aws_vpc.main.id
}

output "vpc_cidr" {
  value = aws_vpc.main.cidr_block
}

output "private_subnet_ids" {
  description = "One private subnet per zone, in the order of availability_zones."
  value       = local.private_ids
}

output "private_subnet_cidrs" {
  value = { for zone, subnet in aws_subnet.private : zone => subnet.cidr_block }
}

output "internet_gateway_id" {
  description = "The internet gateway, or null when egress is none. A control plane that wants a public load balancer adds its own public subnets that route here."
  value       = length(aws_internet_gateway.main) == 0 ? null : aws_internet_gateway.main[0].id
}

output "tasks_security_group_id" {
  description = "The group every task wears; the database admits it."
  value       = aws_security_group.tasks.id
}

output "nat_gateway_count" {
  value = length(local.nat_zones)
}

output "interface_endpoints" {
  description = "The services reached through an interface endpoint."
  value       = sort(tolist(var.interface_endpoints))
}
