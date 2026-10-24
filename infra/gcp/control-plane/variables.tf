# The control plane's inputs. Everything under "From the data plane" is what `infra/gcp/example` already
# created: `terraform -chdir=infra/gcp/example output -json control_plane_inputs` prints exactly those
# values, so they never have to be copied by hand (see ../README.md).

# --- identity of the environment -------------------------------------------------------------------------

variable "project_id" {
  description = "The Google Cloud project: the one the data plane lives in."
  type        = string
}

variable "project_number" {
  description = "The project's number. Cloud Run's deterministic URL, https://<service>-<project_number>.<region>.run.app, lets the panel and the API name each other (CORS origin, API base URL) before either service exists."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{6,20}$", var.project_number))
    error_message = "project_number is the numeric project number: gcloud projects describe PROJECT_ID --format='value(projectNumber)'."
  }
}

variable "region" {
  type = string
}

variable "name" {
  description = "The environment's name, the data plane's too. Prefix of every resource here (<name>-api, <name>-panel, <name>-migrate). A service account id is 6 to 30 characters, so the name is at most 20."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2 to 20 characters: a lowercase letter, then lowercase letters, digits and dashes."
  }
}

# --- From the data plane -----------------------------------------------------------------------------------

variable "namespace" {
  description = "The queue namespace (the data plane's `namespace`): the API reads and writes this namespace's jobs and rings its topic."
  type        = string
}

variable "network" {
  description = "The VPC network's name, for Direct VPC egress to the database."
  type        = string
}

variable "subnetwork" {
  description = "The subnet's name. It must have addresses for two revisions of every service here (see the plan's subnet check)."
  type        = string
}

variable "subnet_cidr" {
  description = "The subnet's CIDR range, to check that it has room for the control plane's instances as well as the data plane's."
  type        = string

  validation {
    condition     = can(cidrhost(var.subnet_cidr, 0))
    error_message = "subnet_cidr must be a CIDR range such as 10.10.0.0/24."
  }
}

variable "data_plane_instances" {
  description = "The most instances the data plane runs (its workers at max_instances, plus the tick): what it already needs addresses for."
  type        = number
}

variable "topic_name" {
  description = "The doorbell topic: the API publishes to it when it adds, retries or promotes a job."
  type        = string
}

variable "hot_topic_names" {
  description = "Hot queue => the queue's own topic: the API publishes to these too, and is told the list (QCLOUD_GCP_HOT_QUEUES)."
  type        = map(string)
  default     = {}
}

variable "dead_letter_subscription_names" {
  description = "Queue => dead-letter subscription id. The API may pull from these to peek, and from no other subscription."
  type        = map(string)
  default     = {}
}

variable "database_url_secret" {
  description = "The Secret Manager secret that holds the database URL (the pooler's, when there is one)."
  type = object({
    secret_id = string
    version   = string
  })
}

variable "webhook_key_secret" {
  description = "The secret that holds QCLOUD_WEBHOOK_KEY, the key webhook secrets are sealed with. Null: the API cannot give a webhook a secret (webhook_key_missing)."
  type = object({
    secret_id = string
    version   = string
  })
  default = null
}

variable "database_ca_secret" {
  description = "The secret that holds the database's CA certificate. Needed when database_tls is \"ca-file\"."
  type = object({
    secret_id = string
    version   = string
  })
  default = null
}

variable "database_direct_url_secret" {
  description = "The direct (not pooled) database URL, which the migration job prefers: DDL does not belong behind a transaction pooler. Null when there is no pooler, and the job uses database_url_secret."
  type = object({
    secret_id = string
    version   = string
  })
  default = null
}

variable "database_tls" {
  description = "How the processes check the database's certificate, as in the data plane: \"ca-file\" (verified, the default), \"unverified\" (encrypted, not verified) or \"off\" (a plaintext hop to a pooler on the private network)."
  type        = string
  default     = "ca-file"

  validation {
    condition     = contains(["ca-file", "unverified", "off"], var.database_tls)
    error_message = "database_tls must be \"ca-file\", \"unverified\" or \"off\"."
  }
}

variable "pooled" {
  description = "The database URL points at a transaction pooler (the data plane's `pooler` is set)."
  type        = bool
  default     = false
}

# --- images ----------------------------------------------------------------------------------------------------

variable "api_image" {
  description = "The Control API image (packages/control-api/Dockerfile), by digest where you can: registry/path@sha256:..."
  type        = string
}

variable "panel_image" {
  description = "The panel image (packages/panel/Dockerfile)."
  type        = string
}

# --- sign-in ------------------------------------------------------------------------------------------------------

variable "oidc_issuer" {
  description = "The identity provider's issuer URL (the `iss` claim). Any OIDC provider that signs tokens with a published key set works: the API holds no secret and no user list."
  type        = string

  validation {
    condition     = can(regex("^https://", var.oidc_issuer))
    error_message = "oidc_issuer must be an https URL."
  }
}

variable "oidc_audience" {
  description = "The audience the API requires in a token (`aud`), usually the OAuth client id of the panel or an API identifier. Several are allowed."
  type        = list(string)

  validation {
    condition     = length(var.oidc_audience) >= 1
    error_message = "oidc_audience needs at least one value: a token for another service must not open this API."
  }
}

variable "oidc_jwks_url" {
  description = "Where the provider publishes its signing keys."
  type        = string

  validation {
    condition     = can(regex("^https://", var.oidc_jwks_url))
    error_message = "oidc_jwks_url must be an https URL."
  }
}

variable "oidc_client_id" {
  description = "The panel's OAuth client id at the provider (a public client: authorization code with PKCE, no secret)."
  type        = string
}

variable "oidc_authority" {
  description = "The URL the panel discovers the provider at. Null: the issuer."
  type        = string
  default     = null
}

variable "oidc_scope" {
  description = "Scopes the panel requests. Null: the panel's default."
  type        = string
  default     = null
}

variable "oidc_token_audience" {
  description = "An `audience` parameter some providers need on the authorize request to issue a token for the API. Null: not sent."
  type        = string
  default     = null
}

variable "role_claim" {
  description = "The token claim that carries roles. Null: the API's default (`roles`)."
  type        = string
  default     = null
}

variable "operator_roles" {
  description = "Role values that grant `operator` (writes). Null: the API's default."
  type        = list(string)
  default     = null
}

variable "viewer_roles" {
  description = "Role values that grant `viewer` (reads). Null: the API's default."
  type        = list(string)
  default     = null
}

# --- exposure --------------------------------------------------------------------------------------------------

variable "exposure" {
  description = <<-EOT
    Who can reach the services. Both modes keep the API's own token check; the mode decides what stands in front of it.
      public   HTTPS on the Cloud Run URLs, open to the internet. Cloud Run's IAM check is off (allUsers may invoke);
               the API refuses any request without a valid token, and `/health` is the only route without one.
      private  Internal ingress: the services answer only to the VPC (a VPN, an internal load balancer). Same token check.
    Identity-Aware Proxy is a third way, in front of an external load balancer: see docs/runbooks/deploy-gcp.md.
  EOT
  type        = string
  default     = "public"

  validation {
    condition     = contains(["public", "private"], var.exposure)
    error_message = "exposure must be \"public\" or \"private\"."
  }
}

variable "edge" {
  description = <<-EOT
    An external HTTPS load balancer with a Cloud Armor rate limit in front of both services (F16). Null (the default):
    nothing is added and the Cloud Run URLs are the public address. Set it and the Cloud Run services accept traffic from the
    load balancer only (ingress INTERNAL_LOAD_BALANCER), so the run.app URLs no longer bypass it, and the API and the panel
    are named by these host names (CORS, the panel's API base URL and the redirect URIs all follow). The DNS records are
    yours: point both names at the `edge.ip_address` output, and the Google-managed certificate is issued once they resolve.
    `rate_limit_per_minute` is requests per client address, API and panel together; over it Cloud Armor answers 429. Clients
    behind one shared address share the count, so size it above the busiest. The in-process limiter stays on: it is per
    instance and per principal, this is per address across every instance. The load balancer, the policy and its rule bill
    separately (see Google's Cloud Load Balancing and Cloud Armor pricing). Only HTTPS is served: nothing listens on port 80.
    With `ingest` set the load balancer fronts it too and `ingest_hostname` is required: a third name, a third host rule and
    a policy of its own, because senders are a few shared addresses and their limit (`ingest_rate_limit_per_minute`, per
    client address) is not the panel's.
  EOT
  type = object({
    api_hostname                 = string
    panel_hostname               = string
    rate_limit_per_minute        = optional(number, 1200)
    ingest_hostname              = optional(string)
    ingest_rate_limit_per_minute = optional(number, 6000)
  })
  default = null

  validation {
    condition     = var.edge == null ? true : alltrue([for host in concat([var.edge.api_hostname, var.edge.panel_hostname], var.edge.ingest_hostname == null ? [] : [var.edge.ingest_hostname]) : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", host))])
    error_message = "edge.api_hostname, edge.panel_hostname and edge.ingest_hostname (when set) are lowercase DNS names."
  }
  validation {
    condition     = var.edge == null ? true : length(distinct(concat([var.edge.api_hostname, var.edge.panel_hostname], var.edge.ingest_hostname == null ? [] : [var.edge.ingest_hostname]))) == (var.edge.ingest_hostname == null ? 2 : 3)
    error_message = "edge.api_hostname, edge.panel_hostname and edge.ingest_hostname (when set) must be different names: one name cannot serve two of the services."
  }
  validation {
    condition     = var.edge == null ? true : var.edge.rate_limit_per_minute >= 1 && floor(var.edge.rate_limit_per_minute) == var.edge.rate_limit_per_minute
    error_message = "edge.rate_limit_per_minute is a whole number from 1."
  }
  validation {
    condition     = var.edge == null ? true : var.edge.ingest_rate_limit_per_minute >= 1 && floor(var.edge.ingest_rate_limit_per_minute) == var.edge.ingest_rate_limit_per_minute
    error_message = "edge.ingest_rate_limit_per_minute is a whole number from 1."
  }
}

variable "extra_cors_origins" {
  description = "Further exact origins the API answers cross-origin calls from (for example a custom domain in front of the panel). A wildcard is refused by the API."
  type        = list(string)
  default     = []
}

# --- capacity and timeouts -------------------------------------------------------------------------------------

variable "api_min_instances" {
  description = "Instances kept warm. One by default (D1): the cost is small and the first request is not a cold start."
  type        = number
  default     = 1
}

variable "api_max_instances" {
  description = "Most API instances. Each holds api_pool_size database connections, which the data plane's connection budget must count (see budgeted_control_processes)."
  type        = number
  default     = 2

  validation {
    condition     = var.api_max_instances >= 1 && floor(var.api_max_instances) == var.api_max_instances
    error_message = "api_max_instances must be a whole number, 1 or more."
  }
}

variable "api_pool_size" {
  description = "Database connections one API instance holds."
  type        = number
  default     = 2

  validation {
    condition     = var.api_pool_size >= 1 && floor(var.api_pool_size) == var.api_pool_size
    error_message = "api_pool_size must be a whole number, 1 or more."
  }
}

variable "api_concurrency" {
  description = "Requests one instance handles at once. An event stream holds a slot for its whole life, so this is more than api_event_streams."
  type        = number
  default     = 100
}

variable "api_event_streams" {
  description = "Most event streams one instance holds. The rest of api_concurrency stays free for ordinary requests."
  type        = number
  default     = 50
}

variable "api_request_timeout_seconds" {
  description = "Cloud Run's request timeout for the API (at most 3600). It must outlast an event stream's lifetime, so the API closes a stream cleanly before the platform cuts it."
  type        = number
  default     = 900
}

variable "event_stream_lifetime_seconds" {
  description = "How long the API keeps one event stream open before closing it (the client resumes with Last-Event-ID). At least 600."
  type        = number
  default     = 600

  validation {
    condition     = var.event_stream_lifetime_seconds >= 600
    error_message = "event_stream_lifetime_seconds must be at least 600."
  }
}

variable "event_heartbeat_seconds" {
  description = "The interval of the comment line that keeps a stream alive through proxies. Nothing in front may time out an idle connection sooner than this."
  type        = number
  default     = 15
}

variable "api_cpu" {
  type    = string
  default = "1"
}

variable "api_memory" {
  type    = string
  default = "512Mi"
}

variable "ingest" {
  description = <<-EOT
    The inbound listener (packages/ingest; docs/event-gateway.md): the public address a sender posts to. Null (the default):
    none is deployed, and a source's address cannot be reached. It is its own Cloud Run service, open to the internet like
    the API (`exposure` and `edge` apply to it too), with its own service account that reads the database secrets and
    holds no Pub/Sub role: it stores what it is sent and never calls a destination. Each instance holds `pool_size`
    database connections, which the data plane's connection budget must count (see budgeted_control_processes). Its limits
    are per process (body size, a rate per source, a global rate); the per-address limit is the edge's.
  EOT
  type = object({
    image         = string
    min_instances = optional(number, 1)
    max_instances = optional(number, 2)
    pool_size     = optional(number, 2)
    concurrency   = optional(number, 100)
    cpu           = optional(string, "1")
    memory        = optional(string, "256Mi")
  })
  default = null

  validation {
    condition     = var.ingest == null ? true : var.ingest.max_instances >= 1 && floor(var.ingest.max_instances) == var.ingest.max_instances && var.ingest.pool_size >= 1 && floor(var.ingest.pool_size) == var.ingest.pool_size
    error_message = "ingest.max_instances and ingest.pool_size are whole numbers, 1 or more."
  }
}

variable "panel_min_instances" {
  type    = number
  default = 1
}

variable "panel_max_instances" {
  type    = number
  default = 2
}

variable "panel_cpu" {
  type    = string
  default = "1"
}

variable "panel_memory" {
  type    = string
  default = "256Mi"
}

variable "panel_csp_connect_extra" {
  description = "Further origins the panel's content security policy lets the page connect to, for example an AI provider the panel's copilot calls. Each is an exact origin."
  type        = list(string)
  default     = []
}

variable "migrate_timeout_seconds" {
  description = "The migration job's deadline."
  type        = number
  default     = 600
}

# --- the connection budget -------------------------------------------------------------------------------------

variable "budgeted_control_processes" {
  description = "The data plane's `control_processes`: how many processes with a pool its connection budget counts. The tick is one, each API instance is one, each ingest instance is one; the panel holds no connection."
  type        = number
  default     = 3
}

variable "budgeted_control_pool_size" {
  description = "The data plane's `control_pool_size`: the pool each of those was budgeted for."
  type        = number
  default     = 2
}

# --- the rest --------------------------------------------------------------------------------------------------

variable "alert_api_errors" {
  description = "Create the alert policy for the API answering with 5xx. It needs the Cloud Monitoring API enabled in the project."
  type        = bool
  default     = true
}

variable "api_errors_per_second" {
  description = "Alert when 5xx responses stay above this rate (per second, averaged over a minute) for five minutes. The default is one every ten seconds."
  type        = number
  default     = 0.1
}

variable "notification_channels" {
  description = "Notification channel ids for the alert policy. Empty: it shows incidents and notifies nobody."
  type        = list(string)
  default     = []
}

variable "runbook_base_url" {
  description = "Where the runbooks are published, without a trailing slash. The alert links to its runbook under this address."
  type        = string
  default     = "docs/runbooks"
}

variable "monitoring_read" {
  description = "Let the API read Pub/Sub depth and age from Cloud Monitoring (one custom role with a single permission, `monitoring.timeSeries.list`, on the project). Without it the Transport page shows depth and age as unavailable, never as zero."
  type        = bool
  default     = true
}

variable "deployer_members" {
  description = "Who runs Terraform (user:... or serviceAccount:...): each gets iam.serviceAccountUser on the service accounts below, which creating a Cloud Run service that runs as them needs."
  type        = set(string)
  default     = []
}

variable "fleet" {
  description = "The workers' size, for the deployment page's connection budget. Null: the page reports no fleet."
  type = object({
    workers           = number
    pool_size         = optional(number)
    listeners         = optional(number)
    control_processes = optional(number)
    pooler_pool_size  = optional(number)
  })
  default = null
}

variable "labels" {
  type    = map(string)
  default = {}
}
