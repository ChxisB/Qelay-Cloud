# The control plane on AWS: the Control API and the panel as ECS Fargate services behind one load balancer (and, when
# asked for, the inbound listener, ingest.tf), and the migration as a one-off task. Read README.md first, and
# ../README.md for the data plane. It sits beside the data
# plane (`../example`), not inside it: the data plane is applied once and rarely, the control plane every time a build
# is released, and the two have different owners. They meet at the values listed under "From the data plane" in
# variables.tf.
#
# What is NOT here, because the data plane already has it: the maintenance tick (a one-shot task, ../modules/tick) and
# the EventBridge Scheduler schedule that starts it every minute (../modules/scheduler). Nothing here listens for the
# tick, so there is nothing to authenticate: see "The tick" in README.md.

data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
  tags      = merge({ app = "qelay-cloud", environment = var.name, component = "control-plane" }, var.tags)

  public = var.exposure == "public"

  api_name   = "${var.name}-api"
  panel_name = "${var.name}-panel"
  api_url    = "https://${var.api_hostname}"
  panel_url  = "https://${var.panel_hostname}"

  ingress_cidrs = var.ingress_cidrs == null ? (local.public ? ["0.0.0.0/0"] : [var.vpc_cidr]) : var.ingress_cidrs

  # The migration reads the direct URL when there is one: DDL runs on the database, not behind a pooler.
  migrate_url_secret = coalesce(var.database_direct_url_secret, var.database_url_secret)
  migrate_pooled     = var.database_direct_url_secret == null && var.pooled

  # The API talks to the database through whatever the data plane's URL points at, and checks its certificate the
  # way the data plane's workers do.
  database_env = merge(
    { QCLOUD_DATABASE_POOLER = var.pooled ? "transaction" : "none" },
    var.database_tls_env,
  )

  # The inbound listener is opt-in (ingest.tf): every count and name below that depends on it is zero or unused without it.
  ingest           = var.ingest != null
  ingest_instances = local.ingest ? var.ingest.instances : 0

  # Autoscaling (autoscaling.tf) moves a service between its minimum (api_instances, ingest.instances) and these. The
  # connection budget and the subnet room are counted at the maximum, because that is what can run.
  api_max_instances    = coalesce(var.api_max_instances, var.api_instances)
  ingest_max_instances = local.ingest ? coalesce(var.ingest.max_instances, var.ingest.instances) : 0
  cluster_name         = element(split("/", var.cluster_arn), 1)

  log_groups = {
    api     = "/qcloud/${var.name}/api"
    panel   = "/qcloud/${var.name}/panel"
    migrate = "/qcloud/${var.name}/migrate"
    ingest  = "/qcloud/${var.name}/ingest"
  }

  oidc_authority = coalesce(var.oidc_authority, var.oidc_issuer)

  # Written from the account and the name, like the data plane's, so its queue policies can admit this role before it
  # exists (additional_principal_arns), and the policies below can name it in a plan.
  role_arn = { for role in ["api-task", "api-execution", "panel-execution", "migrate-execution", "ingest-execution"] : role => "arn:${local.partition}:iam::${var.account_id}:role/${var.name}-${role}" }

  # Every task takes an address from a private subnet, and a rollover leaves the stopped tasks' interfaces for a
  # while, so twice the count is the working figure. The data plane counted its own; these are ours (the API, the
  # panel, the ingest when there is one, and one migration task). Derived from the counts, not measured on Fargate.
  subnet_prefix   = tonumber(split("/", var.vpc_cidr)[1]) + 4
  subnet_usable   = pow(2, 32 - local.subnet_prefix) - 5 # AWS reserves five addresses of every subnet
  tasks_total     = var.data_plane_tasks + local.api_max_instances + local.ingest_max_instances + var.panel_instances + 1
  subnet_required = 2 * local.tasks_total
}

resource "terraform_data" "inputs" {
  input = var.name

  lifecycle {
    precondition {
      condition     = !local.public || var.internet_gateway_id != null
      error_message = "exposure = \"public\" needs the data plane's internet gateway, and it has none (its egress is none). Use exposure = \"private\", or give the data plane a NAT gateway."
    }
    precondition {
      condition     = var.egress == "nat" || var.jwks_reachable_in_vpc
      error_message = "The data plane's egress is none: the API fetches the identity provider's signing keys from oidc_jwks_url and the VPC has no route to the internet. Provide a private route to the provider and set jwks_reachable_in_vpc = true, or give the data plane a NAT gateway."
    }
    precondition {
      condition     = length(var.private_subnet_ids) == length(var.availability_zones)
      error_message = "private_subnet_ids and availability_zones must list the same zones, in the same order."
    }
    precondition {
      condition     = local.api_max_instances + local.ingest_max_instances + 2 <= var.budgeted_control_processes
      error_message = "The connection budget counts ${var.budgeted_control_processes} control processes (two overlapping ticks, each API task and each ingest task, at the most autoscaling can reach): ${local.api_max_instances + local.ingest_max_instances + 2} would run. Raise the data plane's control_processes, or lower api_max_instances, ingest.max_instances or the minimums."
    }
    precondition {
      condition     = local.api_max_instances >= var.api_instances && local.ingest_max_instances >= local.ingest_instances
      error_message = "api_max_instances must be at least api_instances, and ingest.max_instances at least ingest.instances."
    }
    precondition {
      condition     = var.api_pool_size <= var.budgeted_control_pool_size
      error_message = "The connection budget counts ${var.budgeted_control_pool_size} connections per control process; api_pool_size is ${var.api_pool_size}. Raise the data plane's control_pool_size, or lower api_pool_size."
    }
    precondition {
      condition     = local.ingest ? var.ingest.pool_size <= var.budgeted_control_pool_size : true
      error_message = "The connection budget counts ${var.budgeted_control_pool_size} connections per control process; ingest.pool_size is ${local.ingest ? var.ingest.pool_size : 0}. Raise the data plane's control_pool_size, or lower ingest.pool_size."
    }
    precondition {
      condition     = local.ingest ? length(distinct([var.api_hostname, var.panel_hostname, var.ingest.hostname])) == 3 : true
      error_message = "api_hostname, panel_hostname and ingest.hostname must be three different names: the load balancer routes by host name."
    }
    precondition {
      condition     = var.alb_idle_timeout_seconds >= 2 * var.event_heartbeat_seconds
      error_message = "alb_idle_timeout_seconds (${var.alb_idle_timeout_seconds}) must be at least twice event_heartbeat_seconds (${var.event_heartbeat_seconds}): the load balancer must never see an event stream as idle."
    }
    precondition {
      condition     = var.api_event_streams >= 1
      error_message = "api_event_streams must be at least 1."
    }
    precondition {
      condition     = local.subnet_required <= local.subnet_usable
      error_message = "A private subnet of vpc_cidr ${var.vpc_cidr} (a /${local.subnet_prefix}) has ${local.subnet_usable} usable addresses; the whole environment (${var.data_plane_tasks} tasks from the data plane, plus the control plane's) needs ${local.subnet_required} during a rollover. Use a larger vpc_cidr in the data plane, or lower the instance counts."
    }
    precondition {
      condition     = !local.public || (var.alb_subnet_slot >= 8 + length(var.availability_zones) && var.alb_subnet_slot + length(var.availability_zones) <= 16)
      error_message = "The load balancer's subnets take the ${length(var.availability_zones)} slots from alb_subnet_slot (${var.alb_subnet_slot}) of sixteen in vpc_cidr: they must be at or after slot ${8 + length(var.availability_zones)} (the data plane's NAT subnets take 8 and up) and end by slot 16."
    }
    precondition {
      condition     = alltrue([for cidr in local.ingress_cidrs : can(cidrhost(cidr, 0))])
      error_message = "ingress_cidrs takes IPv4 CIDR ranges such as 203.0.113.0/24."
    }
    precondition {
      condition     = alltrue([for origin in concat(var.extra_cors_origins, var.panel_csp_connect_extra) : can(regex("^https?://[^/*]+$", origin))])
      error_message = "extra_cors_origins and panel_csp_connect_extra take exact origins (scheme and host, no path, no wildcard)."
    }
    precondition {
      condition     = var.api_hostname != var.panel_hostname
      error_message = "api_hostname and panel_hostname must differ: the load balancer routes by host name."
    }
  }
}

# The role the data plane's queue policies were told to admit is the one made here: its ARN is
# arn:<partition>:iam::<account>:role/<name>-api-task, which holds as long as it keeps this name and the default path.
# (The check reads the two attributes the ARN is built from, so it is evaluated in the plan.)
check "api_task_role_is_the_admitted_one" {
  assert {
    condition     = aws_iam_role.api_task.name == "${var.name}-api-task" && aws_iam_role.api_task.path == "/"
    error_message = "The API's task role must be ${local.role_arn["api-task"]}: the data plane's queue policies admit that ARN and no other, and every call to a queue from another role is denied."
  }
}
