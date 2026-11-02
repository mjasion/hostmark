output "lb_ip" {
  value       = google_compute_global_address.lb.address
  description = "Point the A record of `domain` here; the managed certificate is issued after it resolves."
}

output "bucket" {
  value = google_storage_bucket.media.name
}

output "url_map" {
  value = google_compute_url_map.app.name
}

output "secrets_to_fill" {
  value       = [google_secret_manager_secret.database_url.secret_id, google_secret_manager_secret.auth_secret.secret_id]
  description = "Secret Manager secrets whose values the owner adds (scripts/deploy.sh does it from the environment)."
}
