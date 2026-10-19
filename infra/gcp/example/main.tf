# One Qelay-Cloud environment on GCP: database, doorbell, workers, tick, scheduler, identities, secrets and
# alerts. Read ../README.md first: what it costs, what the connection budget means, and which steps have only
# been planned, never applied.

locals {
  # Cloud SQL's managed pooler answers on the instance's own address at 6432, with Google's default of 50 server
  # connections. `pooled` and the pool size must not wait on the database (the budget sizes the database), so only
  # the address does.
  pooled                  = var.database_managed_pooling || var.pooler != null
  pooler_server_pool_size = var.database_managed_pooling ? 50 : try(var.pooler.server_pool_size, 20)
  pooler_host             = var.database_managed_pooling ? module.database.private_ip_address : try(var.pooler.host, null)
  pooler_port             = var.database_managed_pooling ? 6432 : try(var.pooler.port, null)
  use_ca                  = var.database_tls == "ca-file"

  apis = [
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "run.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "monitoring.googleapis.com",
    "iam.googleapis.com",
    "parametermanager.googleapis.com",
  ]

  labels = merge({ app = "qelay-cloud", environment = var.name }, var.labels)

  # --- the connection strings: the one place the password is assembled ---------------------------------
  direct_url = "postgres://${module.database.user_name}:${module.database.password}@${module.database.private_ip_address}:5432/${module.database.database_name}"
  # Behind a pooler, every process connects to the pooler; the direct URL is kept for LISTEN.
  database_url = local.pooled ? "postgres://${module.database.user_name}:${module.database.password}@${local.pooler_host}:${local.pooler_port}/${module.database.database_name}" : local.direct_url

  secret_names = toset(concat(
    ["database-url"],
    local.use_ca ? ["database-ca"] : [],
    local.pooled ? ["database-listen-url"] : [],
    var.webhooks ? ["webhook-key"] : [],
  ))
  secret_values = merge(
    { "database-url" = local.database_url },
    { for key in ["database-ca"] : key => module.database.server_ca_cert if local.use_ca },
    { for key in ["database-listen-url"] : key => local.direct_url if local.pooled },
    { for key in ["webhook-key"] : key => random_id.webhook_key[0].hex if var.webhooks },
  )

  # --- what every process is told ------------------------------------------------------------------------
  ca_directory = "/etc/qcloud/db-ca"
  ca_file      = "${local.ca_directory}/ca.pem"

  tls_env = {
    "ca-file"    = tomap({ QCLOUD_DATABASE_TLS_CA_FILE = local.ca_file })
    "unverified" = tomap({ QCLOUD_DATABASE_TLS = "unverified" })
    "off"        = tomap({ QCLOUD_DATABASE_TLS = "off" })
  }

  runtime_env = merge(
    {
      QCLOUD_NAMESPACE       = var.namespace
      QCLOUD_TRANSPORT       = "gcp-pubsub"
      QCLOUD_GCP_PROJECT     = var.project_id
      QCLOUD_DATABASE_POOLER = local.pooled ? "transaction" : "none"
    },
    module.messaging.hot_queues == "" ? {} : { QCLOUD_GCP_HOT_QUEUES = module.messaging.hot_queues },
    local.tls_env[var.database_tls],
  )

  secret_ref = {
    for key in local.secret_names : key => {
      secret_id = module.secrets.secret_ids[key]
      version   = module.secrets.version_numbers[key]
    }
  }

  # The tick reads the URL, the CA and the webhook key; a worker reads the URL and the CA, and the direct URL behind
  # a pooler, for LISTEN. A worker never holds the webhook key: it sends nothing.
  database_secret_env = { QCLOUD_DATABASE_URL = local.secret_ref["database-url"] }
  tick_secret_env = merge(
    local.database_secret_env,
    { for key in ["webhook-key"] : "QCLOUD_WEBHOOK_KEY" => local.secret_ref[key] if var.webhooks },
  )
  tick_secret_keys   = toset(concat(["database-url"], local.use_ca ? ["database-ca"] : [], var.webhooks ? ["webhook-key"] : []))
  worker_secret_keys = setsubtract(local.secret_names, ["webhook-key"])
  worker_secret_env = merge(
    local.database_secret_env,
    { for key in ["database-listen-url"] : "QCLOUD_DATABASE_LISTEN_URL" => local.secret_ref[key] if local.pooled },
  )
  secret_files = { for key in ["database-ca"] : local.ca_file => local.secret_ref[key] if local.use_ca }

  # --- the subnet: Direct VPC egress gives each instance an address ------------------------------------
  # A rollover runs old and new revisions together, so twice the instances is the working figure. Derived
  # from the instance count, not measured on Cloud Run.
  subnet_prefix   = tonumber(split("/", var.subnet_cidr)[1])
  subnet_usable   = pow(2, 32 - local.subnet_prefix) - 4 # Google reserves four addresses of every subnet
  total_instances = sum([for service in values(var.worker_services) : service.max_instances]) + sum(concat([0], [for pool in values(local.background) : pool.spec.instances])) + 1
  subnet_required = 2 * local.total_instances

  # --- the always-on tick and the webhook sender: the tick image's worker pools, on the tick's identity ----------
  background = merge(
    var.tick_loop == null ? {} : { "tick-loop" = { subcommand = "loop", spec = var.tick_loop } },
    var.webhook_sender == null ? {} : { "webhook-sender" = { subcommand = "send", spec = var.webhook_sender } },
  )

  # --- the pools that follow a queue's backlog -----------------------------------------------------------
  autoscaled = { for key, pool in var.worker_services : "${var.name}-${key}" => pool if pool.autoscaling != null }
}

resource "terraform_data" "inputs" {
  input = var.name

  lifecycle {
    precondition {
      condition     = var.database_tls != "off" || local.pooled
      error_message = "database_tls = \"off\" needs a pooler: the instance accepts only encrypted connections, so a plaintext connection can only be to a pooler that speaks TLS to the instance."
    }
    precondition {
      condition     = alltrue([for pool in values(local.autoscaled) : contains(keys(var.queues), pool.autoscaling.queue)])
      error_message = "A worker pool's autoscaling.queue is not in `queues`: there is no subscription to follow."
    }
    precondition {
      condition     = var.webhook_sender == null || var.webhooks
      error_message = "webhook_sender needs webhooks = true: the sender signs with QCLOUD_WEBHOOK_KEY."
    }
    precondition {
      condition     = !var.database_managed_pooling || var.pooler == null
      error_message = "database_managed_pooling and pooler are exclusive: one pooler in front of the database."
    }
    precondition {
      condition     = local.subnet_required <= local.subnet_usable
      error_message = "The workers' subnet ${var.subnet_cidr} has ${local.subnet_usable} usable addresses and ${local.total_instances} instances at most (counting the tick) need ${local.subnet_required} during a rollover. Use a larger subnet_cidr or lower max_instances."
    }
  }
}

resource "google_project_service" "api" {
  for_each = var.enable_apis ? toset(local.apis) : toset([])

  service            = each.key
  disable_on_destroy = false
}

# The key webhook secrets are sealed with: 32 random bytes as 64 hex digits (QCLOUD_WEBHOOK_KEY).
resource "random_id" "webhook_key" {
  count = var.webhooks ? 1 : 0

  byte_length = 32
}

# --- network, budget, database ---------------------------------------------------------------------------

module "network" {
  source = "../modules/network"

  name        = var.name
  region      = var.region
  subnet_cidr = var.subnet_cidr

  abandon_peering_on_destroy = var.abandon_peering_on_destroy

  depends_on = [google_project_service.api]
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
    {
      for name, pool in local.background : name => {
        max_instances      = pool.spec.instances
        pool_size          = pool.spec.pool_size
        listen_connections = 0
      }
    },
  )
  control_processes       = var.control_processes
  control_pool_size       = var.control_pool_size
  pooled                  = local.pooled
  pooler_server_pool_size = local.pooler_server_pool_size
}

module "database" {
  source = "../modules/database"

  name                = var.name
  region              = var.region
  network_id          = module.network.network_id
  tier                = var.database_tier
  edition             = var.database_edition
  managed_pooling     = var.database_managed_pooling
  session_timeouts    = var.database_session_timeouts
  high_availability   = var.database_high_availability
  disk_size_gb        = var.database_disk_size_gb
  max_connections     = module.budget.max_connections
  deletion_protection = var.database_deletion_protection
  labels              = local.labels
}

# --- doorbell, secrets, identities ---------------------------------------------------------------------

module "messaging" {
  source = "../modules/messaging"

  namespace      = var.namespace
  queues         = var.queues
  project_number = var.project_number
  labels         = local.labels

  depends_on = [google_project_service.api]
}

module "secrets" {
  source = "../modules/secrets"

  name          = var.name
  secret_names  = local.secret_names
  secret_values = local.secret_values
  labels        = local.labels

  depends_on = [google_project_service.api]
}

module "iam" {
  source = "../modules/iam"

  name               = var.name
  topic_name         = module.messaging.topic_name
  hot_topic_names    = module.messaging.hot_topic_names
  subscription_names = module.messaging.subscription_names
  secret_ids         = module.secrets.secret_ids
  worker_secrets     = local.worker_secret_keys
  tick_secrets       = local.tick_secret_keys
  deployer_members   = var.deployer_members

  depends_on = [google_project_service.api]
}

# --- the workers ----------------------------------------------------------------------------------------

module "workers" {
  source   = "../modules/workers"
  for_each = var.worker_services

  name                  = "${var.name}-${each.key}"
  region                = var.region
  image                 = coalesce(each.value.image, var.worker_image)
  service_account_email = module.iam.workers_email
  min_instances         = each.value.min_instances
  max_instances         = each.value.max_instances
  pool_size             = each.value.pool_size
  cpu                   = each.value.cpu
  memory                = each.value.memory
  network               = module.network.network_name
  subnetwork            = module.network.subnetwork_name
  env                   = merge(local.runtime_env, each.value.env)
  secret_env            = local.worker_secret_env
  secret_files          = local.secret_files
  labels                = local.labels

  # The pool reads its secrets at start: it must not be created before it is allowed to.
  depends_on = [module.iam, module.messaging, google_project_service.api]
}

# The tick image as long-running pools: `loop` (a beat every second) and `send` (the webhook sender). The tick's
# identity reads the database and webhook secrets and rings the bells; neither process subscribes to a queue.
module "background" {
  source   = "../modules/workers"
  for_each = local.background

  name                  = "${var.name}-${each.key}"
  region                = var.region
  image                 = var.tick_image
  command               = var.tick_command
  args                  = [each.value.subcommand]
  service_account_email = module.iam.tick_email
  min_instances         = each.value.spec.instances
  max_instances         = each.value.spec.instances
  pool_size             = each.value.spec.pool_size
  cpu                   = each.value.spec.cpu
  memory                = each.value.spec.memory
  network               = module.network.network_name
  subnetwork            = module.network.subnetwork_name
  env                   = merge(local.runtime_env, each.value.spec.env)
  secret_env            = local.tick_secret_env
  secret_files          = local.secret_files
  labels                = local.labels

  depends_on = [module.iam, module.messaging, google_project_service.api]
}

# One small always-on service, only when a pool sets `autoscaling`: a worker pool does not scale by itself.
module "autoscaler" {
  source = "../modules/autoscaler"
  count  = length(local.autoscaled) > 0 ? 1 : 0

  name       = var.name
  project_id = var.project_id
  region     = var.region
  image      = var.autoscaler_image
  targets = {
    for pool, config in local.autoscaled : pool => {
      subscription         = module.messaging.subscription_names[config.autoscaling.queue]
      min_instances        = config.min_instances
      max_instances        = config.max_instances
      backlog_per_instance = config.autoscaling.backlog_per_instance
    }
  }
  workers_service_account_email = module.iam.workers_email
  labels                        = local.labels

  depends_on = [module.workers, google_project_service.api]
}

module "tick" {
  source = "../modules/tick"

  name                            = "${var.name}-tick"
  region                          = var.region
  project_number                  = var.project_number
  image                           = var.tick_image
  command                         = var.tick_command
  service_account_email           = module.iam.tick_email
  scheduler_service_account_email = module.iam.scheduler_email
  pool_size                       = var.control_pool_size
  network                         = module.network.network_name
  subnetwork                      = module.network.subnetwork_name
  env                             = local.runtime_env
  secret_env                      = local.tick_secret_env
  secret_files                    = local.secret_files
  labels                          = local.labels

  depends_on = [module.iam, module.messaging, google_project_service.api]
}

module "scheduler" {
  source = "../modules/scheduler"

  name                  = "${var.name}-tick"
  region                = var.region
  tick_url              = module.tick.tick_url
  audience              = module.tick.audience
  service_account_email = module.iam.scheduler_email
  schedule              = var.scheduler_schedule

  depends_on = [google_project_service.api]
}

module "monitoring" {
  source = "../modules/monitoring"

  name                           = var.name
  project_id                     = var.project_id
  dead_letter_subscription_names = values(module.messaging.dead_letter_subscription_names)
  subscription_names             = values(module.messaging.subscription_names)
  database_instance_name         = module.database.instance_name
  max_connections                = var.max_connections
  scheduler_job_name             = module.scheduler.name
  worker_pool_names              = [for worker in module.workers : worker.name]
  notification_channels          = var.notification_channels
  runbook_base_url               = var.runbook_base_url
  claim_latency_metric_type      = var.claim_latency_metric_type
  failed_total_metric_type       = var.failed_total_metric_type

  depends_on = [google_project_service.api]
}
