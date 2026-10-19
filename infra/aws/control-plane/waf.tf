# An edge rate limit for the control plane (F16). Opt-in: see `edge_rate_limit_per_minute` in variables.tf.
#
# The API's own limiter is a token bucket per principal in each task's memory, so N tasks give a caller N times the
# limit and a restart forgets it. This rule counts per client address across every task, before the request reaches one.
# Both stay on: this one is the first line, the API's is the second.

resource "aws_wafv2_web_acl" "edge" {
  count = var.edge_rate_limit_per_minute == null ? 0 : 1

  name        = "${var.name}-control"
  description = "Qelay-Cloud control plane: a rate limit per client address"
  scope       = "REGIONAL"
  tags        = local.tags

  default_action {
    allow {}
  }

  rule {
    name     = "rate-per-address"
    priority = 10

    action {
      block {
        custom_response {
          response_code = 429
          response_header {
            name  = "Retry-After"
            value = "60"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.edge_rate_limit_per_minute
        aggregate_key_type    = "IP"
        evaluation_window_sec = 60
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-control-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-control"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "edge" {
  count = var.edge_rate_limit_per_minute == null ? 0 : 1

  resource_arn = aws_lb.control.arn
  web_acl_arn  = aws_wafv2_web_acl.edge[0].arn
}
