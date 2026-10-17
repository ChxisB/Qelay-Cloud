# The network: one VPC, a private subnet per zone, and the ways out. Nothing here is reachable from the
# internet: tasks and the database sit in private subnets, and the only public resources are the NAT gateway's
# subnet and address (egress = "nat"). Traffic to S3 goes through the free gateway endpoint, so image layers
# pulled from ECR do not pay the NAT gateway's per-GB charge; traffic to the services in interface_endpoints
# stays on the AWS network.

locals {
  nat         = var.egress == "nat"
  zones       = { for index, zone in var.availability_zones : zone => index }
  nat_zones   = local.nat ? (var.nat_per_az ? var.availability_zones : [var.availability_zones[0]]) : []
  private_ids = [for zone in var.availability_zones : aws_subnet.private[zone].id]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = var.name })
}

# The default security group allows everything inside the VPC. Taking its rules away means a resource that is
# placed in it by accident can talk to nothing.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${var.name}-default-unused" })
}

resource "aws_subnet" "private" {
  for_each = local.zones

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, each.value)
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-private-${each.key}", tier = "private" })
}

resource "aws_subnet" "public" {
  for_each = local.nat ? { for zone in local.nat_zones : zone => local.zones[zone] } : {}

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, 8 + each.value)
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-public-${each.key}", tier = "public" })
}

resource "aws_internet_gateway" "main" {
  count = local.nat ? 1 : 0

  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = var.name })
}

resource "aws_eip" "nat" {
  for_each = toset(local.nat_zones)

  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-${each.key}" })
}

resource "aws_nat_gateway" "main" {
  for_each = toset(local.nat_zones)

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id
  tags          = merge(var.tags, { Name = "${var.name}-${each.key}" })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  count = local.nat ? 1 : 0

  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  count = local.nat ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public[0].id
}

# A route table per private subnet, so each can point at the NAT gateway of its own zone.
resource "aws_route_table" "private" {
  for_each = local.zones

  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${var.name}-private-${each.key}" })
}

resource "aws_route" "private_nat" {
  for_each = local.nat ? local.zones : {}

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[contains(local.nat_zones, each.key) ? each.key : local.nat_zones[0]].id
}

resource "aws_route_table_association" "private" {
  for_each = local.zones

  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for table in aws_route_table.private : table.id]
  tags              = merge(var.tags, { Name = "${var.name}-s3" })
}

# --- security groups ------------------------------------------------------------------------------------

# Every task (workers and the tick) wears this group. The database admits it by id, and nothing admits anything
# else: a task accepts no inbound connection at all.
resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "Qelay-Cloud tasks: outbound HTTPS and PostgreSQL, no inbound"
  vpc_id      = aws_vpc.main.id
  tags        = merge(var.tags, { Name = "${var.name}-tasks" })
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  description       = "HTTPS to the AWS APIs, through the endpoints or the NAT gateway"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "tasks_postgres" {
  security_group_id = aws_security_group.tasks.id
  description       = "PostgreSQL to the database or the proxy, inside the VPC"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "Interface endpoints: HTTPS from the tasks"
  vpc_id      = aws_vpc.main.id
  tags        = merge(var.tags, { Name = "${var.name}-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_tasks" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from the tasks"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_vpc_endpoint" "interface" {
  for_each = var.interface_endpoints

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.private_ids
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(var.tags, { Name = "${var.name}-${each.key}" })
}
