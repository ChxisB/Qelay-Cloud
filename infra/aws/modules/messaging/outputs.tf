output "queue_names" {
  description = "Qelay queue => the SQS queue's name."
  value       = local.queue_names
}

output "dead_letter_names" {
  description = "Qelay queue => the dead-letter queue's name."
  value       = local.dead_letter_names
}

output "queue_arns" {
  description = "Qelay queue => queue ARN, written from the names, so known at plan time."
  value       = local.queue_arns
}

output "dead_letter_arns" {
  value = local.dead_letter_arns
}

output "queue_urls" {
  description = "Qelay queue => queue URL."
  value       = { for name, queue in aws_sqs_queue.main : name => queue.url }
}

output "dead_letter_urls" {
  value = { for name, queue in aws_sqs_queue.dead_letter : name => queue.url }
}

output "kms_key_arn" {
  description = "The key the queues are encrypted with; null with encryption = \"sqs-managed\"."
  value       = local.key_arn
}

output "hashed" {
  description = "Qelay queue => true when its names are the hash form."
  value       = local.hashed_by
}
