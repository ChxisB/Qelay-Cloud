# One topic per environment, one filtered subscription per queue, and a dead-letter topic with a filtered
# subscription per queue. A queue marked `hot` gets its own topic and an unfiltered subscription instead:
# its bells are not checked against every other queue's filter and it does not count towards the shared
# topic's 10,000 subscriptions. The names, the filter and the settings are the ones
# packages/transport-gcp/src/{names,provision}.ts use: the transport never creates a resource, so a
# resource this file does not make, or makes differently, is an error a worker reports.
#
# The bell is a doorbell: Postgres decides every outcome, so there is no ordering key and no exactly-once
# delivery, and a duplicate or a lost bell costs latency only. A subscription's filter cannot be changed
# after creation; changing it replaces the subscription (and drops what it holds), which is why the filter
# is derived from the namespace and the queue and not offered as an input.

locals {
  hot_queues           = toset([for name, queue in var.queues : name if queue.hot])
  topic_id             = "qcloud.${var.namespace}.bells"
  dead_letter_topic    = "qcloud.${var.namespace}.bells-dlq"
  retention            = "${var.message_retention_days * 86400}s"
  pubsub_service_agent = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic" "bells" {
  name   = local.topic_id
  labels = var.labels
}

# A hot queue's own topic: the transport's `queueNames(namespace, queue, true).topic`. Every process must be
# told the same list (QCLOUD_GCP_HOT_QUEUES). Moving a queue between the shared topic and its own replaces
# its subscription (a subscription cannot change topic): what it held is rung again by the tick.
resource "google_pubsub_topic" "hot" {
  for_each = local.hot_queues

  name   = "qcloud.${var.namespace}.hot.${each.key}"
  labels = var.labels
}

resource "google_pubsub_topic" "dead_letter" {
  name   = local.dead_letter_topic
  labels = var.labels
}

resource "google_pubsub_subscription" "queue" {
  for_each = var.queues

  name   = "qcloud.${var.namespace}.sub.${each.key}"
  topic  = each.value.hot ? google_pubsub_topic.hot[each.key].id : google_pubsub_topic.bells.id
  labels = var.labels
  filter = each.value.hot ? null : "attributes.route = \"${var.namespace}.${each.key}\""

  ack_deadline_seconds         = each.value.ack_deadline_seconds
  message_retention_duration   = local.retention
  retain_acked_messages        = false
  enable_message_ordering      = false
  enable_exactly_once_delivery = false

  # Never expire: the provider's default deletes a subscription nobody pulled from in 31 days, and the
  # bell path of a quiet queue would silently go with it. (The SDK's dev helper omits this; Terraform
  # does not.)
  expiration_policy {
    ttl = ""
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = each.value.max_delivery_attempts
  }

  retry_policy {
    minimum_backoff = "${each.value.min_backoff_seconds}s"
    maximum_backoff = "${each.value.max_backoff_seconds}s"
  }
}

resource "google_pubsub_subscription" "dead_letter" {
  for_each = var.queues

  name   = "qcloud.${var.namespace}.dlq.${each.key}"
  topic  = google_pubsub_topic.dead_letter.id
  labels = var.labels
  filter = "attributes.route = \"${var.namespace}.${each.key}\""

  ack_deadline_seconds         = 30
  message_retention_duration   = local.retention
  retain_acked_messages        = false
  enable_message_ordering      = false
  enable_exactly_once_delivery = false

  expiration_policy {
    ttl = ""
  }
}

# Dead-lettering works through the Pub/Sub service agent, which must publish to the dead-letter topic and
# acknowledge from each subscription it forwards from. The emulator checks neither; the real service does.

resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  topic  = google_pubsub_topic.dead_letter.name
  role   = "roles/pubsub.publisher"
  member = local.pubsub_service_agent
}

resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  for_each = var.queues

  subscription = google_pubsub_subscription.queue[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}
