variable "project_id" {
  description = "The GCP project id."
  type        = string
}

variable "project_number" {
  description = "The project number: gcloud projects describe PROJECT_ID --format='value(projectNumber)'. A variable, not a lookup, so a plan needs no credentials. It names the Pub/Sub service agent and the tick's URL."
  type        = string
}

variable "region" {
  description = "The region of everything regional. Put the workers near the database: every claim is a round trip."
  type        = string
}

variable "name" {
  description = "The environment's name: the prefix of every resource. 2 to 20 characters (it becomes service account ids)."
  type        = string
  default     = "qcloud"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2 to 20 characters: a lowercase letter, then lowercase letters, digits and dashes."
  }
}

variable "namespace" {
  description = "QCLOUD_NAMESPACE: the tenant of every row and of every Pub/Sub name. Letters, digits and dashes."
  type        = string
  default     = "default"
}

variable "queues" {
  description = "The queues that get a doorbell path (see the messaging module). A queue not listed here has none."
  type = map(object({
    ack_deadline_seconds  = optional(number, 30)
    max_delivery_attempts = optional(number, 5)
    min_backoff_seconds   = optional(number, 1)
    max_backoff_seconds   = optional(number, 10)
  }))
  default = { default = {} }
}

variable "worker_image" {
  description = "The default worker image. A service may set its own."
  type        = string
}

variable "tick_image" {
  description = "The tick image: the Control API's image (packages/control-api/Dockerfile) with tick_command set, or any image whose entrypoint is the maintenance package's qcloud-tick."
  type        = string
}

variable "tick_command" {
  description = "Overrides the tick image's entrypoint. Null runs the image as built. With the Control API's image: [\"bun\", \"/app/packages/maintenance/src/bin.ts\"]."
  type        = list(string)
  default     = null
}

variable "worker_services" {
  description = "Cloud Run worker pools, by name. A pool does not scale by itself: it stays at min_instances until `autoscaling` names a queue (a key of `queues`), which starts Google's CREMA autoscaler (one extra always-on Cloud Run service) and follows that queue's backlog between min_instances and max_instances, with backlog_per_instance un-acked bells per instance. Every pool has a max_instances, and the connection budget counts max_instances x (pool_size + listen_connections). listen_connections is 1 for a service whose every instance holds a LISTEN connection (the local postgres transport does; the Pub/Sub transport and QueueEvents do not), 0 otherwise. A LISTEN connection is direct, bypasses a pooler, and so counts in the pooled budget too."
  type = map(object({
    image              = optional(string)
    min_instances      = optional(number, 1)
    max_instances      = number
    pool_size          = optional(number, 2)
    listen_connections = optional(number, 0)
    cpu                = optional(string, "1")
    memory             = optional(string, "512Mi")
    env                = optional(map(string), {})
    autoscaling = optional(object({
      queue                = string
      backlog_per_instance = optional(number, 10)
    }))
  }))
  default = { worker = { max_instances = 10 } }
}

variable "control_processes" {
  description = "Processes beyond the worker services that hold a pool: the tick (this configuration) and each Control API instance at its max (infra/gcp/control-plane). The panel holds no connection."
  type        = number
  default     = 3
}

variable "control_pool_size" {
  type    = number
  default = 2
}

variable "database_tier" {
  description = "Cloud SQL machine tier. The default, db-custom-1-3840 (1 vCPU, 3.75 GB), is the smallest dedicated-core tier: shared-core tiers have no SLA and a handful of connections. The database is the cost floor of the whole environment."
  type        = string
  default     = "db-custom-1-3840"
}

variable "database_high_availability" {
  description = "A regional standby in another zone, at about double the instance cost. Off: a zonal failure restores from the latest backup."
  type        = bool
  default     = false
}

variable "database_disk_size_gb" {
  type    = number
  default = 10
}

variable "max_connections" {
  description = "The database's max_connections. The budget is checked against it, and the flag is set from it. The value Cloud SQL accepts depends on the tier's memory; an unsupported value fails at apply."
  type        = number
  default     = 100
}

variable "database_deletion_protection" {
  description = "Deletion protection on the instance, in Terraform and in the API. Leave on; the README's teardown says how to turn it off on purpose."
  type        = bool
  default     = true
}

variable "database_tls" {
  description = <<-EOT
    How processes verify the database. "ca-file" (default): the instance's CA is mounted from Secret Manager and
    verified (QCLOUD_DATABASE_TLS_CA_FILE). Cloud SQL's server certificate has no usable subject alternative name, so
    whether hostname verification passes on a private IP is not proven here (README, "needs D9"); "unverified"
    encrypts without verifying. "off" is plaintext, for a plaintext hop to a pooler on the private network, and needs
    pooler to be set: the instance itself refuses plaintext.
  EOT
  type        = string
  default     = "ca-file"

  validation {
    condition     = contains(["ca-file", "unverified", "off"], var.database_tls)
    error_message = "database_tls must be ca-file, unverified or off."
  }
}

variable "pooler" {
  description = <<-EOT
    A transaction pooler (PgBouncer) in front of the database, which this configuration does not create. When set,
    processes connect to it (QCLOUD_DATABASE_POOLER=transaction, prepared statements off), a separate direct URL goes
    to QCLOUD_DATABASE_LISTEN_URL for LISTEN, and the budget is the pooler's server_pool_size plus the reserve, not
    one pool per process. Recommended above about 80% of max_connections.
  EOT
  type = object({
    host             = string
    port             = optional(number, 6432)
    server_pool_size = optional(number, 20)
  })
  default = null
}

variable "subnet_cidr" {
  description = "The workers' subnet. Each Cloud Run instance takes an address from it, and a rollover briefly doubles that."
  type        = string
  default     = "10.10.0.0/24"
}

variable "abandon_peering_on_destroy" {
  description = "Teardown aid: forget the private services peering instead of deleting it (README, teardown)."
  type        = bool
  default     = false
}

variable "scheduler_schedule" {
  description = "The scheduler job's cron expression."
  type        = string
  default     = "* * * * *"
}

variable "notification_channels" {
  description = "Notification channel ids for the alert policies. Empty: they show incidents and notify nobody."
  type        = list(string)
  default     = []
}

variable "runbook_base_url" {
  description = "Where the runbooks are published, without a trailing slash. Each alert links to its runbook under this address."
  type        = string
  default     = "docs/runbooks"
}

variable "claim_latency_metric_type" {
  description = "Cloud Monitoring metric type of qcloud.worker.claim_ms, if your workers export it (docs/observability.md). Empty: no claim latency alert."
  type        = string
  default     = ""
}

variable "failed_total_metric_type" {
  description = "Cloud Monitoring metric type of qcloud.tick.jobs.failed_total, if you export it from the tick (docs/observability.md). Empty: no dead-letter growth alert."
  type        = string
  default     = ""
}

variable "deployer_members" {
  description = "Who runs Terraform (user:... or serviceAccount:...): each gets iam.serviceAccountUser on the three service accounts."
  type        = set(string)
  default     = []
}

variable "enable_apis" {
  description = "Enable the Google APIs this configuration uses. They stay enabled on destroy. Turn off if your organisation enables them elsewhere."
  type        = bool
  default     = true
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "autoscaler_image" {
  description = "The CREMA image, used only when a worker pool sets `autoscaling`. The default is Google's, at the tag its README recommends: read its release notes before moving it."
  type        = string
  default     = "us-central1-docker.pkg.dev/cloud-run-oss-images/crema-v1/autoscaler:1.3"
}
