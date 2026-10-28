# An edge rate limit for the control plane (F16). Opt-in: see `edge_rate_limit_per_minute` in variables.tf.
#
# The API's own limiter is a token bucket per principal in each task's memory, so N tasks give a caller N times the
# limit and a restart forgets it. This rule counts per client address across every task, before the request reaches one.
# Both stay on: this one is the first line, the API's is the second.
#
# With an ingest the ACL has a second rule for the ingest's host name, with its own limit (`ingest.rate_limit_per_minute`),
# and the first rule stops counting that host: a sender's bursts are not an operator's traffic, and neither may use up
# the other's allowance. The host is matched as a prefix, lower-cased, so a port after it (`in.example.com:443`) is still
# the ingest's. shortcut: a prefix match would also take a host name that merely starts with the ingest's (api.example.com.au
# for an ingest at api.example.com), which the three distinct names do not rule out; give the ingest a name no other starts with.

locals {
  # The same test, for both rules.
  ingest_host_match = local.ingest ? {
    search_string         = var.ingest.hostname
    positional_constraint = "STARTS_WITH"
  } : null
}

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

        dynamic "scope_down_statement" {
          for_each = local.ingest ? [local.ingest_host_match] : []
          content {
            not_statement {
              statement {
                byte_match_statement {
                  search_string         = scope_down_statement.value.search_string
                  positional_constraint = scope_down_statement.value.positional_constraint

                  field_to_match {
                    single_header {
                      name = "host"
                    }
                  }

                  text_transformation {
                    priority = 0
                    type     = "LOWERCASE"
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-control-rate"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = local.ingest ? [var.ingest.rate_limit_per_minute] : []
    content {
      name     = "rate-per-address-ingest"
      priority = 20

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
          limit                 = rule.value
          aggregate_key_type    = "IP"
          evaluation_window_sec = 60

          scope_down_statement {
            byte_match_statement {
              search_string         = local.ingest_host_match.search_string
              positional_constraint = local.ingest_host_match.positional_constraint

              field_to_match {
                single_header {
                  name = "host"
                }
              }

              text_transformation {
                priority = 0
                type     = "LOWERCASE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-ingest-rate"
        sampled_requests_enabled   = true
      }
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
