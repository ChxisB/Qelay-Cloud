output "connection_budget" {
  description = "What the fleet can open at full scale against what the database allows."
  value = {
    mode            = local.pooled ? "pooled" : "direct"
    required        = module.budget.required
    max_connections = var.max_connections
    utilization     = module.budget.utilization
    direct_required = module.budget.direct_required
    pooled_required = module.budget.pooled_required
  }
}

output "database_connection_name" {
  description = "project:region:instance, for the Auth Proxy or a /cloudsql socket (not used here)."
  value       = module.database.connection_name
}

output "database_private_ip" {
  value = module.database.private_ip_address
}

output "topic_name" {
  value = module.messaging.topic_name
}

output "dead_letter_topic_name" {
  value = module.messaging.dead_letter_topic_name
}

output "subscription_names" {
  description = "Queue => subscription."
  value       = module.messaging.subscription_names
}

output "dead_letter_subscription_names" {
  description = "Queue => dead-letter subscription."
  value       = module.messaging.dead_letter_subscription_names
}

output "tick_url" {
  description = "The endpoint the scheduler posts to."
  value       = module.tick.tick_url
}

output "tick_audience" {
  value = module.tick.audience
}

output "worker_services" {
  description = "Service names."
  value       = { for name, worker in module.workers : name => worker.name }
}

output "service_accounts" {
  value = {
    workers   = module.iam.workers_email
    tick      = module.iam.tick_email
    scheduler = module.iam.scheduler_email
  }
}

output "secret_ids" {
  description = "Secret Manager ids (not values)."
  value       = module.secrets.secret_ids
}

output "alert_policy_ids" {
  value = module.monitoring.alert_policy_ids
}

output "control_plane_inputs" {
  description = <<-EOT
    What the control plane (../control-plane) takes from this environment: identifiers and secret references, never
    a secret value. `terraform output -json control_plane_inputs > ../control-plane/data-plane.auto.tfvars.json`
    gives it the whole set; the control plane reads it as variables, so the two stay separate roots.
  EOT
  value = {
    project_id                     = var.project_id
    project_number                 = var.project_number
    region                         = var.region
    name                           = var.name
    namespace                      = var.namespace
    network                        = module.network.network_name
    subnetwork                     = module.network.subnetwork_name
    subnet_cidr                    = var.subnet_cidr
    data_plane_instances           = local.total_instances
    topic_name                     = module.messaging.topic_name
    dead_letter_subscription_names = module.messaging.dead_letter_subscription_names
    database_url_secret            = local.secret_ref["database-url"]
    database_ca_secret             = lookup(local.secret_ref, "database-ca", null)
    database_direct_url_secret     = lookup(local.secret_ref, "database-listen-url", null)
    database_tls                   = var.database_tls
    pooled                         = local.pooled
    budgeted_control_processes     = var.control_processes
    budgeted_control_pool_size     = var.control_pool_size
  }
}
