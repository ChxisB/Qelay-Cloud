# One Qelay-Cloud environment on AWS: network, database, doorbell, workers, tick, scheduler, identities, secrets and
# alarms. Read ../README.md first: what it costs, what the connection budget means, and which steps have only been
# planned, never applied.

data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
  pooled    = var.rds_proxy != null
  use_ca    = var.database_tls == "ca-file"
  # A task definition is at most 64 KiB and every service's carries this value; the limit leaves room for the rest.
  # Derived from that limit, not measured on ECS.
  ca_pem_max = 16000
  tags       = merge({ app = "qelay-cloud", environment = var.name }, var.tags)

  # --- the connection strings: the one place the password is assembled -------------------------------------
  direct_url = "postgres://${module.database.user_name}:${module.database.password}@${module.database.address}:${module.database.port}/${module.database.database_name}"
  # Behind the proxy every process connects to the proxy; the direct URL is kept for LISTEN.
  database_url = local.pooled ? "postgres://${module.database.user_name}:${module.database.password}@${module.database.proxy_endpoint}:5432/${module.database.database_name}" : local.direct_url

  secret_names = toset(concat(["database-url"], local.pooled ? ["database-listen-url"] : [], var.webhooks ? ["webhook-key"] : []))
  secret_values = merge(
    { "database-url" = local.database_url },
    { for key in ["database-listen-url"] : key => local.direct_url if local.pooled },
    { for key in ["webhook-key"] : key => random_id.webhook_key[0].hex if var.webhooks },
  )

  # --- what every process is told ----------------------------------------------------------------------------
  tls_env = {
    "ca-pem"     = tomap({ QCLOUD_DATABASE_TLS_CA = var.database_ca_pem })
    "ca-file"    = tomap({ QCLOUD_DATABASE_TLS_CA_FILE = var.database_ca_file })
    "unverified" = tomap({ QCLOUD_DATABASE_TLS = "unverified" })
    "off"        = tomap({ QCLOUD_DATABASE_TLS = "off" })
  }

  runtime_env = merge(
    {
      QCLOUD_NAMESPACE       = var.namespace
      QCLOUD_TRANSPORT       = "aws-sqs"
      QCLOUD_AWS_REGION      = var.region
      QCLOUD_DATABASE_POOLER = local.pooled ? "transaction" : "none"
    },
    local.tls_env[var.database_tls],
  )

  # ECS reads a secret's value with the execution role and needs the secret's full ARN (name plus random suffix).
  secret_ref = { for key in local.secret_names : key => module.secrets.arns[key] }

  # The webhook key seals and opens the webhook secrets: the tick, the loop, the sender and the API hold it, a job worker never.
  tick_secret_keys    = concat(["database-url"], var.webhooks ? ["webhook-key"] : [])
  worker_secret_keys  = sort(tolist(setsubtract(local.secret_names, ["webhook-key"])))
  database_secret_env = { QCLOUD_DATABASE_URL = local.secret_ref["database-url"] }
  tick_secret_env = merge(
    local.database_secret_env,
    { for key in ["webhook-key"] : "QCLOUD_WEBHOOK_KEY" => local.secret_ref[key] if var.webhooks },
  )
  worker_secret_env = merge(
    local.database_secret_env,
    { for key in ["database-listen-url"] : "QCLOUD_DATABASE_LISTEN_URL" => local.secret_ref[key] if local.pooled },
  )
  # A task reads its secrets once, at start: a changed secret must roll the services to reach them.
  rollout_trigger      = join(",", [for key in local.worker_secret_keys : module.secrets.version_ids[key]])
  tick_rollout_trigger = join(",", [for key in local.tick_secret_keys : module.secrets.version_ids[key]])

  # The always-on pools of the tick image: the loop and the sender, each a fixed number of tasks on the tick's roles.
  background = merge(
    var.tick_loop == null ? {} : { "tick-loop" = { subcommand = "loop", spec = var.tick_loop } },
    var.webhook_sender == null ? {} : { "webhook-sender" = { subcommand = "send", spec = var.webhook_sender } },
  )
  background_logs  = { for key in keys(local.background) : key => "/qcloud/${var.name}/${key}" }
  background_tasks = sum(concat([0], [for pool in values(local.background) : pool.spec.instances]))
  # What the budget counts: every task holds a pool and none a LISTEN connection.
  background_budget = { for key, pool in local.background : key => { max_instances = pool.spec.instances, pool_size = pool.spec.pool_size, listen_connections = 0 } }

  database_instance_class = var.database_cluster == null ? var.database_instance_class : var.database_cluster.instance_class

  # --- the endpoints ------------------------------------------------------------------------------------------
  # With a NAT gateway the tasks reach every AWS API through it, and the endpoints only keep the two busiest calls
  # off it. Without one the endpoints are the only way out, so they must cover everything a task calls: SQS (bells),
  # Secrets Manager (the start-up read), CloudWatch Logs, and ECR (the image: its API, its registry, and its layers,
  # which are in S3: the free gateway endpoint the network module always creates).
  endpoint_defaults = {
    nat  = ["sqs", "secretsmanager"]
    none = ["sqs", "secretsmanager", "logs", "ecr.api", "ecr.dkr"]
  }
  interface_endpoints = var.interface_endpoints == null ? local.endpoint_defaults[var.egress] : var.interface_endpoints
  missing_endpoints   = var.egress == "none" ? setsubtract(toset(local.endpoint_defaults["none"]), local.interface_endpoints) : toset([])

  # --- names that more than one module must agree on, written here and not read back -----------------------
  cluster_name  = var.name
  tick_family   = "${var.name}-tick"
  tick_log_name = "/qcloud/${var.name}/tick"
  # The variable's validation guarantees the form; the tick alarm follows the schedule.
  tick_schedule_minutes = tonumber(regex("[0-9]+", var.scheduler_schedule))
  worker_logs           = { for key in keys(var.worker_services) : key => "/qcloud/${var.name}/workers/${key}" }

  # --- the subnets: every task takes an address from one ---------------------------------------------------
  # A rollover leaves the stopped tasks' network interfaces for a while, so twice the task count is the working
  # figure, and the worst case puts them all in one subnet. Derived from the counts, not measured on Fargate.
  # AWS reserves five addresses of every subnet. The tick may overlap itself once.
  subnet_prefix   = tonumber(split("/", var.vpc_cidr)[1]) + 4
  subnet_usable   = pow(2, 32 - local.subnet_prefix) - 5
  total_tasks     = sum([for service in values(var.worker_services) : service.max_instances]) + local.background_tasks + 2
  subnet_required = 2 * local.total_tasks

  # Scaling on a queue that does not exist would fail at apply with a message about a dimension, not about the typo.
  scaled_queues = toset([for service in values(var.worker_services) : service.autoscaling.queue if service.autoscaling != null])
}

resource "terraform_data" "inputs" {
  input = var.name

  lifecycle {
    precondition {
      condition     = var.database_tls != "off" || local.pooled
      error_message = "database_tls = \"off\" needs rds_proxy: the instance accepts only encrypted connections (rds.force_ssl), so a plaintext connection can only be to a proxy that speaks TLS to the instance."
    }
    precondition {
      condition     = var.database_tls != "ca-pem" || can(regex("-----BEGIN CERTIFICATE-----", var.database_ca_pem))
      error_message = "database_tls = \"ca-pem\" needs database_ca_pem: the PEM text of the database region's CA bundle (see the variable). Without one, choose unverified on purpose."
    }
    precondition {
      condition     = length(var.database_ca_pem) <= local.ca_pem_max
      error_message = "database_ca_pem is ${length(var.database_ca_pem)} characters; a task definition carries at most about ${local.ca_pem_max} of it. Use the region's bundle, not the global one."
    }
    precondition {
      condition     = local.subnet_required <= local.subnet_usable
      error_message = "A private subnet of vpc_cidr ${var.vpc_cidr} (a /${local.subnet_prefix}) has ${local.subnet_usable} usable addresses and ${local.total_tasks} tasks at most (counting two ticks) need ${local.subnet_required} during a rollover. Use a larger vpc_cidr or lower max_instances."
    }
    precondition {
      condition     = length(local.missing_endpoints) == 0
      error_message = "egress = \"none\" has no route out but the interface endpoints. Missing: ${join(", ", sort(tolist(local.missing_endpoints)))}. A task could not pull its image, write its logs, read its secret or receive a bell."
    }
    precondition {
      condition     = var.webhook_sender == null || var.webhooks
      error_message = "webhook_sender needs webhooks = true: the sender signs with QCLOUD_WEBHOOK_KEY."
    }
    precondition {
      condition     = length(setsubtract(local.scaled_queues, toset(keys(var.queues)))) == 0
      error_message = "A worker service scales on a queue that is not in `queues`: ${join(", ", sort(tolist(setsubtract(local.scaled_queues, toset(keys(var.queues))))))}."
    }
  }
}

# --- network, budget, database ---------------------------------------------------------------------------

module "network" {
  source = "../modules/network"

  name                = var.name
  region              = var.region
  vpc_cidr            = var.vpc_cidr
  availability_zones  = var.availability_zones
  egress              = var.egress
  nat_per_az          = var.nat_per_az
  interface_endpoints = local.interface_endpoints
  tags                = local.tags
}

module "budget" {
  source = "../../modules/budget"

  max_connections = var.max_connections
  services = merge(
    {
      for name, service in var.worker_services : name => {
        max_instances      = service.max_instances
        pool_size          = service.pool_size
        listen_connections = service.listen_connections
      }
    },
    local.background_budget,
  )
  control_processes = var.control_processes
  control_pool_size = var.control_pool_size
  pooled            = local.pooled
  # The proxy opens at most its share of max_connections to the instance, and that is the pooled budget.
  pooler_server_pool_size = local.pooled ? floor(var.max_connections * var.rds_proxy.max_connections_percent / 100) : 20
}

module "database" {
  source = "../modules/database"

  name                      = var.name
  region                    = var.region
  partition                 = local.partition
  account_id                = var.account_id
  vpc_id                    = module.network.vpc_id
  vpc_cidr                  = module.network.vpc_cidr
  subnet_ids                = module.network.private_subnet_ids
  client_security_group_ids = [module.network.tasks_security_group_id]
  instance_class            = var.database_instance_class
  multi_az                  = var.database_multi_az
  cluster                   = var.database_cluster
  allocated_storage_gb      = var.database_storage_gb
  max_allocated_storage_gb  = var.database_max_storage_gb
  backup_retention_days     = var.database_backup_retention_days
  max_connections           = module.budget.max_connections
  session_timeouts          = var.database_session_timeouts
  deletion_protection       = var.database_deletion_protection
  proxy                     = var.rds_proxy
  secrets_kms_key_arn       = var.secrets_kms_key_arn
  tags                      = local.tags
}

# --- doorbell, secrets, identities ---------------------------------------------------------------------

module "messaging" {
  source = "../modules/messaging"

  namespace   = var.namespace
  queues      = var.queues
  account_id  = var.account_id
  region      = var.region
  partition   = local.partition
  kms_key_arn = var.queue_kms_key_arn
  tags        = local.tags
}

module "secrets" {
  source = "../modules/secrets"

  name          = var.name
  secret_names  = local.secret_names
  secret_values = local.secret_values
  kms_key_arn   = var.secrets_kms_key_arn
  tags          = local.tags
}

module "iam" {
  source = "../modules/iam"

  name                      = var.name
  account_id                = var.account_id
  region                    = var.region
  partition                 = local.partition
  queue_arns                = module.messaging.queue_arns
  queue_urls                = module.messaging.queue_urls
  dead_letter_arns          = module.messaging.dead_letter_arns
  dead_letter_urls          = module.messaging.dead_letter_urls
  queue_key_enabled         = true
  kms_key_arn               = module.messaging.kms_key_arn
  worker_secret_names       = { for key in local.worker_secret_keys : key => module.secrets.names[key] }
  tick_secret_names         = { for key in local.tick_secret_keys : key => module.secrets.names[key] }
  secrets_kms_key_arn       = var.secrets_kms_key_arn
  image_repository_arns     = var.image_repository_arns
  cluster_name              = local.cluster_name
  workers_log_groups        = values(local.worker_logs)
  tick_log_group            = local.tick_log_name
  tick_extra_log_groups     = values(local.background_logs)
  tick_family               = local.tick_family
  schedule_name             = "${var.name}-tick"
  additional_principal_arns = var.additional_principal_arns
  tags                      = local.tags
}

# --- the services ----------------------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = local.cluster_name
  tags = local.tags
}

# Both providers on the cluster costs nothing. A worker service uses Spot only when its `spot` is true.
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

module "workers" {
  source   = "../modules/workers"
  for_each = var.worker_services

  name               = "${var.name}-${each.key}"
  region             = var.region
  image              = coalesce(each.value.image, var.worker_image)
  cluster_arn        = aws_ecs_cluster.main.arn
  cluster_name       = aws_ecs_cluster.main.name
  task_role_arn      = module.iam.workers_task_role_arn
  execution_role_arn = module.iam.workers_execution_role_arn
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [module.network.tasks_security_group_id]
  min_instances      = each.value.min_instances
  max_instances      = each.value.max_instances
  spot               = each.value.spot
  pool_size          = each.value.pool_size
  cpu                = each.value.cpu
  memory             = each.value.memory
  cpu_architecture   = var.cpu_architecture
  env                = merge(local.runtime_env, each.value.env)
  secret_env         = local.worker_secret_env
  rollout_trigger    = local.rollout_trigger
  log_group_name     = local.worker_logs[each.key]
  log_retention_days = var.log_retention_days
  autoscaling = each.value.autoscaling == null ? null : {
    queue_name       = module.messaging.queue_names[each.value.autoscaling.queue]
    scale_out_above  = each.value.autoscaling.scale_out_above
    scale_in_below   = each.value.autoscaling.scale_in_below
    scale_out_step   = each.value.autoscaling.scale_out_step
    scale_in_step    = each.value.autoscaling.scale_in_step
    cooldown_seconds = each.value.autoscaling.cooldown_seconds
  }
  tags = local.tags

  # The service reads its secrets at start: it must not be created before it is allowed to. A service that names
  # FARGATE_SPOT is refused until the cluster has the provider.
  depends_on = [module.iam, module.messaging, module.network, aws_ecs_cluster_capacity_providers.main]
}

module "tick" {
  source = "../modules/tick"

  name               = local.tick_family
  region             = var.region
  image              = var.tick_image
  command            = var.tick_command
  task_role_arn      = module.iam.tick_task_role_arn
  execution_role_arn = module.iam.tick_execution_role_arn
  cpu_architecture   = var.cpu_architecture
  pool_size          = var.control_pool_size
  env                = local.runtime_env
  secret_env         = local.tick_secret_env
  log_group_name     = local.tick_log_name
  log_retention_days = var.log_retention_days
  tags               = local.tags

  depends_on = [module.iam, module.messaging]
}

resource "random_id" "webhook_key" {
  count = var.webhooks ? 1 : 0

  byte_length = 32
}

module "background" {
  source   = "../modules/workers"
  for_each = local.background

  name               = "${var.name}-${each.key}"
  region             = var.region
  image              = var.tick_image
  entry_point        = var.tick_command
  command            = [each.value.subcommand]
  cluster_arn        = aws_ecs_cluster.main.arn
  cluster_name       = aws_ecs_cluster.main.name
  task_role_arn      = module.iam.tick_task_role_arn
  execution_role_arn = module.iam.tick_execution_role_arn
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [module.network.tasks_security_group_id]
  min_instances      = each.value.spec.instances
  max_instances      = each.value.spec.instances
  pool_size          = each.value.spec.pool_size
  cpu                = each.value.spec.cpu
  memory             = each.value.spec.memory
  cpu_architecture   = var.cpu_architecture
  env                = merge(local.runtime_env, each.value.spec.env)
  secret_env         = local.tick_secret_env
  rollout_trigger    = local.tick_rollout_trigger
  log_group_name     = local.background_logs[each.key]
  log_retention_days = var.log_retention_days
  tags               = local.tags

  depends_on = [module.iam, module.messaging, module.network]
}

module "scheduler" {
  source = "../modules/scheduler"

  name                = "${var.name}-tick"
  schedule_expression = var.scheduler_schedule
  enabled             = var.scheduler_enabled
  cluster_arn         = aws_ecs_cluster.main.arn
  task_definition_arn = module.tick.task_definition_arn_without_revision
  role_arn            = module.iam.scheduler_role_arn
  subnet_ids          = module.network.private_subnet_ids
  security_group_ids  = [module.network.tasks_security_group_id]
}

module "monitoring" {
  source = "../modules/monitoring"

  name                    = var.name
  queue_names             = module.messaging.queue_names
  dead_letter_names       = module.messaging.dead_letter_names
  database_identifier     = module.database.identifier
  max_connections         = var.max_connections
  database_storage_gb     = var.database_storage_gb
  database_dimension      = module.database.metric_dimension
  tick_log_group_name     = local.tick_log_name
  tick_schedule_minutes   = local.tick_schedule_minutes
  tick_missed_minutes     = max(5, 3 * local.tick_schedule_minutes)
  database_instance_class = local.database_instance_class
  cluster_name            = aws_ecs_cluster.main.name
  worker_service_names    = [for worker in module.workers : worker.service_name]
  runbook_base_url        = var.runbook_base_url
  claim_latency_metric    = var.claim_latency_metric
  failed_total_metric     = var.failed_total_metric
  alarm_actions           = var.alarm_actions
  tags                    = local.tags

  depends_on = [module.tick]
}
