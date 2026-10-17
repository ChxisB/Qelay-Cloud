# Secret Manager secrets for what must not travel as plain environment text: the database URL (it holds
# the password) and the CA certificate. Cloud Run reads them at instance start, through the identity of
# the service, which is granted access to each secret it needs and to no other (the iam module).
#
# The values pass through the Terraform state, as every password a Terraform-created database has. The
# state bucket is therefore as sensitive as the secrets themselves.

resource "google_secret_manager_secret" "this" {
  for_each  = var.secret_names
  secret_id = "${var.name}-${each.key}"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "this" {
  for_each    = var.secret_names
  secret      = google_secret_manager_secret.this[each.key].id
  secret_data = var.secret_values[each.key]
}
