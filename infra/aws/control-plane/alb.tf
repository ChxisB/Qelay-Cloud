# One application load balancer in front of both services, routing by host name: api_hostname to the API, panel_hostname
# to the panel, and a 404 for anything else. HTTPS only (port 80 redirects), with a certificate you bring.
#
# The tasks' own group (the data plane's `tasks` group) gains one inbound rule: this load balancer's group, on 8080.
# Nothing else may open a connection to a task. The load balancer's group may reach the tasks and nothing else.
#
# `public` puts the load balancer in subnets of its own that route to the data plane's internet gateway; `private`
# puts it in the data plane's private subnets, where only ingress_cidrs inside the network reach it.

resource "aws_subnet" "alb" {
  for_each = local.public ? { for index, zone in var.availability_zones : zone => index } : {}

  vpc_id                  = var.vpc_id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, var.alb_subnet_slot + each.value)
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-alb-${each.key}", tier = "public" })
}

resource "aws_route_table" "alb" {
  count = local.public ? 1 : 0

  vpc_id = var.vpc_id
  tags   = merge(local.tags, { Name = "${var.name}-alb" })
}

resource "aws_route" "alb_internet" {
  count = local.public ? 1 : 0

  route_table_id         = aws_route_table.alb[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = var.internet_gateway_id
}

resource "aws_route_table_association" "alb" {
  for_each = aws_subnet.alb

  subnet_id      = each.value.id
  route_table_id = aws_route_table.alb[0].id
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-control-alb"
  description = "Qelay-Cloud control plane load balancer: HTTPS in from ingress_cidrs, the tasks' port out"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-control-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(local.ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from ${each.value}"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "http_redirect" {
  for_each = toset(local.ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTP from ${each.value}, answered with a redirect to HTTPS"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "The tasks' port, to the tasks only"
  referenced_security_group_id = var.tasks_security_group_id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = var.tasks_security_group_id
  description                  = "Control plane load balancer to the API and panel"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}

resource "aws_lb" "control" {
  name                       = "${var.name}-control"
  load_balancer_type         = "application"
  internal                   = !local.public
  ip_address_type            = "ipv4"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.public ? [for zone in var.availability_zones : aws_subnet.alb[zone].id] : var.private_subnet_ids
  idle_timeout               = var.alb_idle_timeout_seconds
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_deletion_protection = var.alb_deletion_protection
  tags                       = local.tags
}

resource "aws_lb_target_group" "api" {
  name                 = local.api_name
  port                 = 8080
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = var.deregistration_delay_seconds
  tags                 = local.tags

  # `/health` is the only route without a token, and it touches nothing: a database that is down does not take the API
  # out of the load balancer, it makes `/health/ready` (behind the token) say why.
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "panel" {
  name                 = local.panel_name
  port                 = 8080
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  deregistration_delay = var.deregistration_delay_seconds
  tags                 = local.tags

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.control.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  tags              = local.tags

  # A request for any other host name goes nowhere.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  tags         = local.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [var.api_hostname]
    }
  }
}

resource "aws_lb_listener_rule" "panel" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20
  tags         = local.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.panel.arn
  }

  condition {
    host_header {
      values = [var.panel_hostname]
    }
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.control.arn
  port              = 80
  protocol          = "HTTP"
  tags              = local.tags

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
