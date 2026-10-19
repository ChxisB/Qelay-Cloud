output "topic_name" {
  value = google_pubsub_topic.bells.name
}

output "topic_id" {
  value = google_pubsub_topic.bells.id
}

output "dead_letter_topic_name" {
  value = google_pubsub_topic.dead_letter.name
}

output "subscription_names" {
  description = "Queue name => its subscription's id."
  value       = { for queue, subscription in google_pubsub_subscription.queue : queue => subscription.name }
}

output "dead_letter_subscription_names" {
  description = "Queue name => its dead-letter subscription's id."
  value       = { for queue, subscription in google_pubsub_subscription.dead_letter : queue => subscription.name }
}

output "subscription_ids" {
  description = "Queue name => the subscription's full resource id."
  value       = { for queue, subscription in google_pubsub_subscription.queue : queue => subscription.id }
}

output "hot_topic_names" {
  description = "Hot queue name => the queue's own topic. Empty when every queue is on the shared topic."
  value       = { for queue, topic in google_pubsub_topic.hot : queue => topic.name }
}

output "hot_queues" {
  description = "The value of QCLOUD_GCP_HOT_QUEUES for every process (comma separated, empty when none)."
  value       = join(",", sort(tolist(local.hot_queues)))
}
