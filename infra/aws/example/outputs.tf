output "connection_budget" {
  description = "What the fleet can open at full scale against what the database allows."
  value = {
    mode            = local.pooled ? "pooled" : "direct"
    required        = module.budget.required
    max_connections = var.max_connections
    utilization     = module.budget.utilization
    direct_required = module.budget.direct_required
    pooled_required = module.budget.pooled_required

    worker_role_limit = module.budget.worker_role_limit
  }
}

output "database_address" {
  description = "The instance's private DNS name."
  value       = module.database.address
}

output "database_proxy_endpoint" {
  description = "The RDS Proxy's DNS name, or null without one."
  value       = module.database.proxy_endpoint
}

output "queue_names" {
  description = "Qelay queue => SQS queue name."
  value       = module.messaging.queue_names
}

output "queue_urls" {
  description = "Qelay queue => SQS queue URL."
  value       = module.messaging.queue_urls
}

output "queue_arns" {
  value = module.messaging.queue_arns
}

output "dead_letter_names" {
  value = module.messaging.dead_letter_names
}

output "dead_letter_urls" {
  value = module.messaging.dead_letter_urls
}

output "dead_letter_arns" {
  value = module.messaging.dead_letter_arns
}

output "queue_kms_key_arn" {
  value = module.messaging.kms_key_arn
}

output "tick_target" {
  description = "What starts the tick: the schedule, the cluster, the task definition's family and where its tasks run."
  value = {
    schedule            = module.scheduler.name
    schedule_expression = module.scheduler.schedule_expression
    cluster_arn         = aws_ecs_cluster.main.arn
    task_family         = module.tick.family
    subnet_ids          = module.network.private_subnet_ids
    security_group_ids  = [module.network.tasks_security_group_id]
  }
}

output "worker_services" {
  description = "ECS service names."
  value       = { for name, worker in module.workers : name => worker.service_name }
}

output "role_arns" {
  value = {
    workers_task      = module.iam.workers_task_role_arn
    workers_execution = module.iam.workers_execution_role_arn
    tick_task         = module.iam.tick_task_role_arn
    tick_execution    = module.iam.tick_execution_role_arn
    scheduler         = module.iam.scheduler_role_arn
  }
}

output "processes" {
  description = "What each process runs and is told, without its secrets: the plain environment, and the names of the variables that Secrets Manager fills."
  value = {
    tick = {
      family      = module.tick.family
      entry_point = module.tick.entry_point
      command     = module.tick.command
      environment = module.tick.environment
      secret_env  = module.tick.secret_env_names
      pool_size   = module.tick.pool_size
    }
    workers = {
      for name, worker in module.workers : name => {
        environment   = worker.environment
        secret_env    = worker.secret_env_names
        max_instances = worker.max_instances
        pool_size     = worker.pool_size
      }
    }
    background = {
      for name, pool in module.background : name => {
        entry_point   = pool.entry_point
        command       = pool.command
        environment   = pool.environment
        secret_env    = pool.secret_env_names
        max_instances = pool.max_instances
        pool_size     = pool.pool_size
      }
    }
  }
}

output "secret_names" {
  description = "Secrets Manager secret names (not values)."
  value       = module.secrets.names
}

output "alarm_arns" {
  value = module.monitoring.alarm_arns
}

output "control_plane_inputs" {
  description = <<-EOT
    What the control plane (task 43) takes from this environment: identifiers and secret references, never a secret
    value. `terraform output -json control_plane_inputs` gives it the whole set.
  EOT
  value = {
    account_id                 = var.account_id
    region                     = var.region
    name                       = var.name
    namespace                  = var.namespace
    vpc_id                     = module.network.vpc_id
    private_subnet_ids         = module.network.private_subnet_ids
    tasks_security_group_id    = module.network.tasks_security_group_id
    cluster_arn                = aws_ecs_cluster.main.arn
    data_plane_tasks           = local.total_tasks
    queue_arns                 = module.messaging.queue_arns
    dead_letter_arns           = module.messaging.dead_letter_arns
    queue_kms_key_arn          = module.messaging.kms_key_arn
    database_url_secret        = local.secret_ref["database-url"]
    database_direct_url_secret = lookup(local.secret_ref, "database-listen-url", null)
    webhook_key_secret         = lookup(local.secret_ref, "webhook-key", null)
    database_tls_env           = local.tls_env[var.database_tls]
    vpc_cidr                   = module.network.vpc_cidr
    availability_zones         = var.availability_zones
    internet_gateway_id        = module.network.internet_gateway_id
    egress                     = var.egress
    secrets_kms_key_arn        = var.secrets_kms_key_arn
    rollout_trigger            = local.rollout_trigger
    pooled                     = local.pooled
    budgeted_control_processes = var.control_processes
    budgeted_control_pool_size = var.control_pool_size
  }
}
