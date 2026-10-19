# The control plane's inputs. Everything under "From the data plane" is what `infra/aws/example` already
# created: `terraform -chdir=infra/aws/example output -json control_plane_inputs` prints exactly those
# values, so they never have to be copied by hand (see ../README.md and README.md here).

# --- identity of the environment -------------------------------------------------------------------------

variable "account_id" {
  description = "The 12-digit AWS account the environment lives in. A real run refuses any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  type = string
}

variable "name" {
  description = "The environment's name, the data plane's too. Prefix of every resource here (<name>-api, <name>-panel, <name>-migrate, <name>-control). The data plane's queue policies admit the role <name>-api-task by this name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2 to 20 characters: a lowercase letter, then lowercase letters, digits and dashes."
  }
}

variable "offline_plan" {
  description = "Plan with a placeholder key and no call to AWS (CI only, see versions.tf). Never apply with it."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}

# --- From the data plane -----------------------------------------------------------------------------------

variable "namespace" {
  description = "The queue namespace (the data plane's `namespace`): the API reads and writes this namespace's jobs and rings its queues."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  description = "The VPC's CIDR range. The load balancer's own public subnets are cut from it (alb_subnet_slot), and the check that the tasks fit uses its size."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a CIDR range such as 10.20.0.0/16."
  }
}

variable "availability_zones" {
  description = "The data plane's zones, in the order of private_subnet_ids. The load balancer needs at least two."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "A load balancer needs subnets in at least two zones."
  }
}

variable "private_subnet_ids" {
  description = "The data plane's private subnets: the tasks run here, with no public address."
  type        = list(string)
}

variable "tasks_security_group_id" {
  description = "The group the data plane's tasks wear. The database and the interface endpoints admit it, and its egress is 443 and 5432 only, so the control plane's tasks wear it too and only gain an inbound rule from the load balancer."
  type        = string
}

variable "cluster_arn" {
  description = "The data plane's ECS cluster."
  type        = string
}

variable "data_plane_tasks" {
  description = "The most tasks the data plane runs (its workers at max_instances, plus two ticks): what its subnets already count."
  type        = number
}

variable "queue_arns" {
  description = "Queue => the doorbell queue's ARN. The API rings these and reads their depth."
  type        = map(string)
}

variable "dead_letter_arns" {
  description = "Queue => the dead-letter queue's ARN. The API peeks at these without deleting, and reads their depth."
  type        = map(string)
  default     = {}
}

variable "queue_kms_key_arn" {
  description = "The key the queues are encrypted with. Null when they use SQS's own key."
  type        = string
  default     = null
}

variable "secrets_kms_key_arn" {
  description = "The key the database secrets are encrypted with. Null for the AWS-managed key."
  type        = string
  default     = null
}

variable "database_url_secret" {
  description = "The full ARN of the Secrets Manager secret that holds the database URL (the proxy's, when there is one). ECS reads it at task start."
  type        = string

  validation {
    condition     = can(regex("^arn:[a-z-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+-[A-Za-z0-9]{6}$", var.database_url_secret))
    error_message = "database_url_secret is the secret's full ARN, which ends in a dash and six characters (ECS cannot read a secret by its name here)."
  }
}

variable "database_direct_url_secret" {
  description = "The direct (not pooled) database URL, which the migration prefers: DDL does not belong behind a transaction pooler. Null when there is no proxy, and the migration uses database_url_secret."
  type        = string
  default     = null
}

variable "webhook_key_secret" {
  description = "The full ARN of the secret that holds QCLOUD_WEBHOOK_KEY (the data plane's `webhook_key_secret` output), which the API seals and opens webhook secrets with. Null: no webhooks, and the API refuses to store one."
  type        = string
  default     = null

  validation {
    condition     = var.webhook_key_secret == null ? true : can(regex("^arn:[a-z-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+-[A-Za-z0-9]{6}$", var.webhook_key_secret))
    error_message = "webhook_key_secret is the secret's full ARN, which ends in a dash and six characters (ECS cannot read a secret by its name here)."
  }
}

variable "database_tls_env" {
  description = "How the processes check the database's certificate, exactly as the data plane's workers do: its `database_tls_env` output (QCLOUD_DATABASE_TLS_CA with the PEM, QCLOUD_DATABASE_TLS_CA_FILE, or QCLOUD_DATABASE_TLS)."
  type        = map(string)

  validation {
    condition     = length(var.database_tls_env) == 1 && length(setintersection(keys(var.database_tls_env), ["QCLOUD_DATABASE_TLS_CA", "QCLOUD_DATABASE_TLS_CA_FILE", "QCLOUD_DATABASE_TLS"])) == 1
    error_message = "database_tls_env holds exactly one of QCLOUD_DATABASE_TLS_CA, QCLOUD_DATABASE_TLS_CA_FILE and QCLOUD_DATABASE_TLS: a process refuses two."
  }
}

variable "pooled" {
  description = "The database URL points at a transaction pooler (the data plane has an RDS Proxy)."
  type        = bool
  default     = false
}

variable "rollout_trigger" {
  description = "The data plane's `rollout_trigger`: it changes when a database secret does, which rolls the API (a task reads its secrets once, at start). Empty is fine."
  type        = string
  default     = ""
}

variable "internet_gateway_id" {
  description = "The data plane's internet gateway, or null when its egress is none. A public load balancer needs it."
  type        = string
  default     = null
}

variable "egress" {
  description = "The data plane's egress: nat or none. With none the tasks have no route to the internet, so the API cannot fetch the identity provider's keys unless jwks_reachable_in_vpc says it can."
  type        = string
  default     = "nat"

  validation {
    condition     = contains(["nat", "none"], var.egress)
    error_message = "egress must be nat or none."
  }
}

variable "budgeted_control_processes" {
  description = "The data plane's `control_processes`: how many processes with a pool its connection budget counts. Two ticks may overlap and each API task is one; the panel holds no connection."
  type        = number
  default     = 4
}

variable "budgeted_control_pool_size" {
  description = "The data plane's `control_pool_size`: the pool each of those was budgeted for."
  type        = number
  default     = 2
}

# --- images ----------------------------------------------------------------------------------------------------

variable "api_image" {
  description = "The Control API image (packages/control-api/Dockerfile): the same build as on any other cloud. By digest where you can: registry/path@sha256:..."
  type        = string
}

variable "panel_image" {
  description = "The panel image (packages/panel/Dockerfile): the same build as on any other cloud."
  type        = string
}

variable "image_repository_arns" {
  description = "ECR repositories the two images are pulled from. The execution roles may pull from these and no other. Empty when the images come from a registry that is not ECR."
  type        = list(string)
  default     = []
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64: what the images were built for."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
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

variable "jwks_reachable_in_vpc" {
  description = "Say so when egress is none and the provider's key set is still reachable from the VPC (a private endpoint or a proxy you provide). Terraform cannot check it."
  type        = bool
  default     = false
}

# --- exposure --------------------------------------------------------------------------------------------------

variable "exposure" {
  description = <<-EOT
    Who can reach the services. Both modes keep the API's own token check; the mode decides what stands in front of it.
      public   An internet-facing load balancer in public subnets, HTTPS only (HTTP redirects). Open to ingress_cidrs
               (the internet by default); the API refuses any request without a valid token, and `/health` is the only
               route without one.
      private  An internal load balancer in the private subnets: it answers only to ingress_cidrs inside the network
               (a VPN, a peered VPC). Same token check.
    A third way, the load balancer's own OIDC action, is described in README.md and not built.
  EOT
  type        = string
  default     = "public"

  validation {
    condition     = contains(["public", "private"], var.exposure)
    error_message = "exposure must be \"public\" or \"private\"."
  }
}

variable "certificate_arn" {
  description = "An ACM certificate in this region that covers api_hostname and panel_hostname. HTTPS needs a name of yours: the load balancer's own DNS name cannot have a certificate."
  type        = string

  validation {
    condition     = can(regex("^arn:[a-z-]+:acm:[a-z0-9-]+:[0-9]{12}:certificate/.+$", var.certificate_arn))
    error_message = "certificate_arn must be the ARN of an ACM certificate."
  }
}

variable "api_hostname" {
  description = "The DNS name the Control API answers on, for example api.example.com. Point it at the load balancer (the alb_dns_name output): the DNS record is yours to create."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.api_hostname))
    error_message = "api_hostname must be a lowercase DNS name."
  }
}

variable "panel_hostname" {
  description = "The DNS name the panel answers on, for example qelay.example.com, pointed at the load balancer the same way."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.panel_hostname))
    error_message = "panel_hostname must be a lowercase DNS name."
  }
}

variable "ingress_cidrs" {
  description = "Who may open a connection to the load balancer. Null: the internet for exposure = public, and the VPC for exposure = private."
  type        = list(string)
  default     = null
}

variable "edge_rate_limit_per_minute" {
  description = <<-EOT
    A WAF rate limit on the load balancer: requests per minute from one client address, over the API and the panel together.
    Over it the load balancer answers 429 with `Retry-After: 60` before a request reaches a task. Null (the default) adds no
    WAF and costs nothing; a web ACL bills per ACL, per rule and per million requests (see AWS WAF pricing). Clients behind one shared address (an office, a NAT) share the count, so size it above the
    busiest of them; 1200 is the API's own per-principal limit (20 a second) for a minute. The in-process limiter stays on as
    the second layer: it is per task and per principal, this is per address and shared by every task.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.edge_rate_limit_per_minute == null ? true : var.edge_rate_limit_per_minute >= 10 && floor(var.edge_rate_limit_per_minute) == var.edge_rate_limit_per_minute
    error_message = "edge_rate_limit_per_minute is a whole number from 10 (the least a WAF rate rule takes), or null."
  }
}

variable "alb_subnet_slot" {
  description = "The first of the sixteen equal slots of vpc_cidr (each a /20 in a /16) that the public load balancer's subnets take, one per zone. The data plane uses 0-7 for private subnets and 8 and up for its NAT subnets, so 12 is free for up to four zones."
  type        = number
  default     = 12
}

variable "alb_idle_timeout_seconds" {
  description = "How long the load balancer keeps an idle connection. Must be at least twice event_heartbeat_seconds, so an event stream is never idle; 60 is its default."
  type        = number
  default     = 60

  validation {
    condition     = var.alb_idle_timeout_seconds >= 30 && var.alb_idle_timeout_seconds <= 4000 && floor(var.alb_idle_timeout_seconds) == var.alb_idle_timeout_seconds
    error_message = "alb_idle_timeout_seconds must be a whole number from 30 to 4000."
  }
}

variable "alb_deletion_protection" {
  description = "Deletion protection on the load balancer. Off by default: it holds no data and is recreated by an apply, but the DNS names point at it."
  type        = bool
  default     = false
}

variable "extra_cors_origins" {
  description = "Further exact origins the API answers cross-origin calls from. A wildcard is refused by the API."
  type        = list(string)
  default     = []
}

# --- capacity and timeouts -------------------------------------------------------------------------------------

variable "api_instances" {
  description = "API tasks, a fixed count: each holds api_pool_size database connections, which the data plane's connection budget counts, so this does not scale by itself. Two by default so a rollover keeps one running; with one, a rollover has a gap."
  type        = number
  default     = 2

  validation {
    condition     = var.api_instances >= 1 && floor(var.api_instances) == var.api_instances
    error_message = "api_instances must be a whole number, 1 or more."
  }
}

variable "api_pool_size" {
  description = "Database connections one API task holds."
  type        = number
  default     = 2

  validation {
    condition     = var.api_pool_size >= 1 && floor(var.api_pool_size) == var.api_pool_size
    error_message = "api_pool_size must be a whole number, 1 or more."
  }
}

variable "api_event_streams" {
  description = "Most event streams one task holds open. Each is a connection through the load balancer for up to event_stream_lifetime_seconds."
  type        = number
  default     = 50
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
  description = "The interval of the comment line that keeps a stream alive through proxies. Nothing in front may time out an idle connection sooner than twice this."
  type        = number
  default     = 15

  validation {
    condition     = var.event_heartbeat_seconds >= 15 && var.event_heartbeat_seconds <= 60
    error_message = "event_heartbeat_seconds must be between 15 and 60."
  }
}

variable "shutdown_grace_seconds" {
  description = "How long a stopping API task lets requests in flight finish before it closes the rest, event streams included (at most 60). ECS waits ten seconds longer before it kills the task."
  type        = number
  default     = 8

  validation {
    condition     = var.shutdown_grace_seconds >= 1 && var.shutdown_grace_seconds <= 60
    error_message = "shutdown_grace_seconds must be between 1 and 60."
  }
}

variable "deregistration_delay_seconds" {
  description = "How long the load balancer lets requests in flight finish on a task that is being replaced, before ECS stops it."
  type        = number
  default     = 30
}

variable "api_cpu" {
  description = "Fargate CPU units of an API task."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory (MiB) of an API task."
  type        = number
  default     = 1024
}

variable "panel_instances" {
  description = "Panel tasks. The panel holds no connection, so it is not counted in the budget. Two keep it up through a rollover."
  type        = number
  default     = 2

  validation {
    condition     = var.panel_instances >= 1 && floor(var.panel_instances) == var.panel_instances
    error_message = "panel_instances must be a whole number, 1 or more."
  }
}

variable "panel_cpu" {
  type    = number
  default = 256
}

variable "panel_memory" {
  type    = number
  default = 512
}

variable "panel_csp_connect_extra" {
  description = "Further origins the panel's content security policy lets the page connect to, for example an AI provider the panel's copilot calls. Each is an exact origin."
  type        = list(string)
  default     = []
}

variable "migrate_cpu" {
  type    = number
  default = 512
}

variable "migrate_memory" {
  type    = number
  default = 1024
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# --- the rest --------------------------------------------------------------------------------------------------

variable "monitoring_read" {
  description = "Let the API read the age of the oldest message from CloudWatch (one `cloudwatch:GetMetricData` statement, which takes no resource). Without it the Transport page shows ages as unavailable, never as zero."
  type        = bool
  default     = true
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

# --- alarms ----------------------------------------------------------------------------------------------------

variable "alert_api_errors" {
  description = "Create the alarm on the API's 5xx answers."
  type        = bool
  default     = true
}

variable "api_errors_per_minute" {
  description = "The alarm fires when the API answers with more than this many 5xx a minute for five minutes in a row. An unproven default."
  type        = number
  default     = 5
}

variable "alarm_actions" {
  description = "SNS topic ARNs (or other alarm actions) for the control plane's alarm. Empty: the alarm exists and shows state, and notifies nobody."
  type        = list(string)
  default     = []
}

variable "runbook_base_url" {
  description = "Where the runbooks are published, without a trailing slash. The alarm's description links to its runbook under this address."
  type        = string
  default     = "docs/runbooks"
}
