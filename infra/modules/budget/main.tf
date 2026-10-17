# The connection budget (gate decision, spike 05), shared by every cloud's example. Every service that opens
# database connections has an upper bound on its processes (Cloud Run max_instances, ECS max_instances), so the
# number of connections the fleet can open is known before an apply, and a plan that cannot fit is refused
# instead of discovered as SQLSTATE 53300 under load.
#
#   direct = sum(max_instances x (pool_size + listen_connections)) + control_processes x pool + reserved
#   pooled = pooler_server_pool_size + sum(max_instances x listen_connections) + reserved
#
# A LISTEN connection cannot go through a transaction pooler (it subscribes and then never hears anything),
# so it is opened directly and counts in both. The same arithmetic is packages/store-postgres/src/connection/
# budget.ts, and scripts/check-terraform-plan.ts compares the two.
#
# At pool 2, 10 / 50 / 200 worker processes need 32 / 112 / 412 direct connections, or 26 pooled.

locals {
  worker_connections = sum(concat([0], [
    for service in values(var.services) : service.max_instances * (service.pool_size + service.listen_connections)
  ]))
  listen_connections = sum(concat([0], [
    for service in values(var.services) : service.max_instances * service.listen_connections
  ]))
  control_connections = var.control_processes * var.control_pool_size
  direct_required     = local.worker_connections + local.control_connections + var.reserved_connections
  pooled_required     = var.pooler_server_pool_size + local.listen_connections + var.reserved_connections
  required            = var.pooled ? local.pooled_required : local.direct_required
  utilization         = local.required / var.max_connections
}

resource "terraform_data" "fits" {
  input = local.required

  lifecycle {
    precondition {
      condition     = local.required <= var.max_connections
      error_message = "The fleet can open ${local.required} database connections (${var.pooled ? "pooled: ${var.pooler_server_pool_size} server connections + ${local.listen_connections} LISTEN + ${var.reserved_connections} reserved" : "${local.worker_connections} from worker services + ${local.control_connections} from control processes + ${var.reserved_connections} reserved"}) but max_connections is ${var.max_connections}. Lower max_instances or pool_size, raise max_connections (a larger tier), or put a transaction pooler in front (pooled = true)."
    }
  }
}

check "headroom" {
  assert {
    condition     = local.utilization <= var.warn_above
    error_message = "The connection budget uses ${floor(local.utilization * 100)}% of max_connections (${local.required} of ${var.max_connections}). Above ${floor(var.warn_above * 100)}% a transaction pooler is the safer design."
  }
}
