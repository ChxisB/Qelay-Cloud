variable "account_id" {
  description = "The 12-digit AWS account id. A variable, not a lookup, so a plan needs no credentials: every ARN that a policy names is written from it. The provider refuses any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be the 12-digit account id."
  }
}

variable "region" {
  description = "The region of everything. Put the workers near the database: every claim is a round trip."
  type        = string
}

variable "availability_zones" {
  description = "At least two zones of the region (RDS's subnet group needs two). A variable, not a lookup, so a plan needs no credentials."
  type        = list(string)
}

variable "name" {
  description = "The environment's name: the prefix of every resource. 2 to 20 characters (it becomes role names, which are capped)."
  type        = string
  default     = "qcloud"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2 to 20 characters: a lowercase letter, then lowercase letters, digits and dashes."
  }
}

variable "namespace" {
  description = "QCLOUD_NAMESPACE: the tenant of every row and of every SQS queue name. Letters, digits and dashes."
  type        = string
  default     = "default"
}

variable "queues" {
  description = "The queues that get a doorbell path (see the messaging module). A queue not listed here has none: the transport never creates one, so a worker for it fails with \"queue does not exist\"."
  type = map(object({
    visibility_timeout_seconds    = optional(number, 30)
    max_receive_count             = optional(number, 5)
    retention_seconds             = optional(number, 345600)
    dead_letter_retention_seconds = optional(number, 1209600)
  }))
  default = { default = {} }
}

variable "queue_kms_key_arn" {
  description = "An existing customer-managed KMS key for the queues. Null: the messaging module creates one (with rotation). SQS-managed encryption is available through the module's own variable, not here: the example keeps the stronger default."
  type        = string
  default     = null
}

variable "worker_image" {
  description = "The default worker image. A service may set its own. It runs a Qelay Worker built on the SDK and reads the QCLOUD_* variables; the repository ships no worker image (the Dockerfiles are for the Control API and the panel)."
  type        = string
}

variable "tick_image" {
  description = "The tick image: the Control API's image (packages/control-api/Dockerfile) with tick_command set, or any image whose entrypoint is the maintenance package's qcloud-tick."
  type        = string
}

variable "tick_command" {
  description = "Overrides the tick image's entrypoint. Null runs the image as built. With the Control API's image: [\"bun\", \"/app/packages/maintenance/src/bin.ts\"]. The container's command is always [\"run\"]."
  type        = list(string)
  default     = null
}

variable "image_repository_arns" {
  description = "The ECR repositories the images come from: the execution roles may pull layers from these and no others. Empty for an image from another registry (which then needs egress = \"nat\")."
  type        = list(string)
  default     = []
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64, for the workers and the tick. The images must be built for it."
  type        = string
  default     = "X86_64"
}

variable "worker_services" {
  description = <<-EOT
    ECS Fargate worker services, by name. Every one has a max_instances, and the connection budget counts
    max_instances x (pool_size + listen_connections). listen_connections is 1 for a service whose every task holds a
    LISTEN connection (the local postgres transport does; the SQS transport and QueueEvents do not), 0 otherwise. A
    LISTEN connection is direct, bypasses a pooler, and so counts in the pooled budget too. autoscaling adds tasks while
    the named queue (a key of `queues`) holds more than scale_out_above bells.
  EOT
  type = map(object({
    image              = optional(string)
    min_instances      = optional(number, 1)
    max_instances      = number
    pool_size          = optional(number, 2)
    listen_connections = optional(number, 0)
    cpu                = optional(number, 512)
    memory             = optional(number, 1024)
    env                = optional(map(string), {})
    spot               = optional(bool, false)
    autoscaling = optional(object({
      queue            = string
      scale_out_above  = optional(number, 100)
      scale_in_below   = optional(number, 10)
      scale_out_step   = optional(number, 2)
      scale_in_step    = optional(number, 1)
      cooldown_seconds = optional(number, 120)
    }))
  }))
  default = { worker = { max_instances = 10 } }
}

variable "control_processes" {
  description = "Processes beyond the worker services that hold a pool: the tick tasks that may overlap (a minute's tick that is still running when the next starts) and each Control API instance at its max (task 43). The panel holds no connection. The default, 4, is two overlapping ticks and two Control API instances."
  type        = number
  default     = 4
}

variable "control_pool_size" {
  type    = number
  default = 2
}

variable "database_instance_class" {
  description = "The RDS instance class. The default, db.t4g.small (2 vCPU burstable, 2 GiB), is a small floor: a burstable instance that runs out of CPU credits slows down. The database is the largest fixed cost, with the NAT gateway."
  type        = string
  default     = "db.t4g.small"
}

variable "database_multi_az" {
  description = "A standby in another zone with automatic failover, at about double the instance cost. Off: a zonal failure restores from the latest backup."
  type        = bool
  default     = false
}

variable "database_storage_gb" {
  type    = number
  default = 20
}

variable "database_max_storage_gb" {
  description = "Storage autoscaling's ceiling. Equal to database_storage_gb turns autoscaling off."
  type        = number
  default     = 100
}

variable "database_backup_retention_days" {
  type    = number
  default = 7
}

variable "max_connections" {
  description = "The database's max_connections. The budget is checked against it, and the parameter group is set from it (a reboot applies it). The value RDS accepts depends on the instance's memory; an unsupported value fails at apply."
  type        = number
  default     = 100
}

variable "database_deletion_protection" {
  description = "Deletion protection on the instance, in Terraform and in the API. Leave on; the README's teardown says how to turn it off on purpose. The instance also has prevent_destroy, which a variable cannot lift."
  type        = bool
  default     = true
}

variable "database_tls" {
  description = <<-EOT
    How processes verify the database. "ca-pem" (default): the CA bundle in database_ca_pem is handed to every process as
    QCLOUD_DATABASE_TLS_CA, because Fargate injects environment variables and has no file mount; a certificate is public,
    so this is a plain variable and not a secret. "ca-file": the server is verified against the file at database_ca_file
    (QCLOUD_DATABASE_TLS_CA_FILE), which the IMAGE must then contain. "unverified" encrypts without verifying. "off" is
    plaintext and needs rds_proxy: the instance refuses plaintext (rds.force_ssl), so a plaintext connection can only be
    to a proxy that speaks TLS to it.
  EOT
  type        = string
  default     = "ca-pem"

  validation {
    condition     = contains(["ca-pem", "ca-file", "unverified", "off"], var.database_tls)
    error_message = "database_tls must be ca-pem, ca-file, unverified or off."
  }
}

variable "database_ca_pem" {
  description = <<-EOT
    The CA bundle (PEM text) for database_tls = "ca-pem": the bundle of the database's region, from
    https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem (a few kilobytes). Not the global bundle: it is
    about 170 KB, over what a task definition can carry. Behind rds_proxy the bundle must also hold Amazon's root CAs
    (https://www.amazontrust.com/repository/), which sign the proxy's certificate. Public, not a secret. In a .tfvars file
    use a heredoc.
  EOT
  type        = string
  default     = ""
}

variable "database_ca_file" {
  description = "Where the image keeps the CA bundle for database_tls = \"ca-file\": Amazon's global bundle (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem), which only an image can carry. With rds_proxy the bundle must also hold Amazon's root CAs, which sign the proxy's certificate."
  type        = string
  default     = "/etc/ssl/certs/rds-global-bundle.pem"
}

variable "rds_proxy" {
  description = <<-EOT
    An RDS Proxy in front of the database, in transaction pooling mode. Null (default): none, and every process connects
    to the instance. Set: processes connect to the proxy (QCLOUD_DATABASE_POOLER=transaction), a separate direct URL goes
    to QCLOUD_DATABASE_LISTEN_URL for LISTEN, and the budget is the proxy's share of max_connections plus the reserve.
    Transaction mode disables session features, and a session that uses one is pinned to a server connection, which
    removes the pooling; spike 05 did not measure pinning against this workload, so the proxy is not the default.
  EOT
  type = object({
    max_connections_percent      = optional(number, 50)
    max_idle_connections_percent = optional(number, 25)
    idle_client_timeout_seconds  = optional(number, 1800)
    borrow_timeout_seconds       = optional(number, 30)
  })
  default = null
}

variable "vpc_cidr" {
  description = "The VPC's range. Each zone's private subnet is a sixteenth of it, and each task takes an address from one."
  type        = string
  default     = "10.20.0.0/16"
}

variable "egress" {
  description = "\"nat\": tasks reach the internet through one NAT gateway. \"none\": no internet route at all, and the VPC endpoints carry every AWS call (the README says what that costs and what it needs)."
  type        = string
  default     = "nat"

  validation {
    condition     = contains(["nat", "none"], var.egress)
    error_message = "egress must be nat or none."
  }
}

variable "nat_per_az" {
  description = "One NAT gateway per zone instead of one."
  type        = bool
  default     = false
}

variable "interface_endpoints" {
  description = "The interface endpoints to create, as short service names. Null: [\"sqs\", \"secretsmanager\"] with egress = \"nat\" (the calls the data plane makes that cost NAT traffic), and the full set with egress = \"none\" (sqs, secretsmanager, logs, ecr.api, ecr.dkr; add monitoring if a process asks for queue statistics)."
  type        = set(string)
  default     = null
}

variable "scheduler_schedule" {
  description = "The tick schedule, as rate(N minute|minutes): rate(1 minute) is EventBridge Scheduler's finest grain, and every launch is a Fargate task billed for at least a minute. A longer rate is a safety net for deployments whose workers run the in-process tick (TickLoop in the worker's host: the SDK does not start it for you): without it, delayed jobs, retries and crons wait for the next scheduled tick. The tick alarm follows the rate."
  type        = string
  default     = "rate(1 minute)"

  validation {
    condition     = can(regex("^rate\\((1 minute|([2-9]|[1-9][0-9]+) minutes)\\)$", var.scheduler_schedule))
    error_message = "scheduler_schedule must be rate(1 minute) or rate(N minutes) with N from 2: the tick alarm is derived from it."
  }
}

variable "scheduler_enabled" {
  description = "false creates the schedule paused."
  type        = bool
  default     = true
}

variable "alarm_actions" {
  description = "SNS topic ARNs for the alarms. Empty: the alarms show state and notify nobody."
  type        = list(string)
  default     = []
}

variable "runbook_base_url" {
  description = "Where the runbooks are published, without a trailing slash. Each alarm's description links to its runbook under this address."
  type        = string
  default     = "docs/runbooks"
}

variable "claim_latency_metric" {
  description = "The CloudWatch metric your pipeline gives qcloud.worker.claim_ms, if your workers export it (docs/observability.md). Null: no claim latency alarm."
  type        = object({ namespace = string, name = string })
  default     = null
}

variable "failed_total_metric" {
  description = "The CloudWatch metric your pipeline gives qcloud.tick.jobs.failed_total, if you export it from the tick (docs/observability.md). Null: no dead-letter growth alarm."
  type        = object({ namespace = string, name = string })
  default     = null
}

variable "additional_principal_arns" {
  description = "Roles other than the tasks' that use the queues: the Control API's task role (task 43), an operator's role. The queue policies stop denying them; they still need an identity policy of their own."
  type        = list(string)
  default     = []
}

variable "secrets_kms_key_arn" {
  description = "A customer-managed key for the secrets. Null: the AWS-managed key aws/secretsmanager."
  type        = string
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "offline_plan" {
  description = "Plan with no credentials and no call to AWS. For CI and for reading a plan; never for an apply."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
