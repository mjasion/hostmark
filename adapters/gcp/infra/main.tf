locals {
  bucket     = coalesce(var.bucket_name, "${var.project}-hostmark")
  topic      = "image-jobs"
  dlq_topic  = "image-jobs-dlq"
  worker_sub = "image-jobs-worker"
  # A literal: runtime_env must not reference the url map, which depends on the api service through the backend (D200).
  url_map = "hostmark"
  # Cloud Scheduler cron strings of packages/contract SCHEDULER_JOBS; scripts/check-config.ts compares them.
  scheduler_jobs = {
    "cleanup-expired" = "*/15 * * * *"
    "requeue-stuck"   = "*/5 * * * *"
    "daily-stats"     = "5 0 * * *"
  }
  runtime_env = {
    GCP_PROJECT         = var.project
    PUBSUB_TOPIC        = local.topic
    PUBSUB_SUBSCRIPTION = local.worker_sub
    CDN_URL_MAP         = local.url_map
    S3_ENDPOINT         = "https://storage.googleapis.com"
    S3_BUCKET           = google_storage_bucket.media.name
    S3_REGION           = "auto"
    PUBLIC_URL          = "https://${var.domain}"
    ENVIRONMENT         = "gcp"
    APP_VERSION         = var.app_version
    HOSTMARK_TOPOLOGY   = "single"
    WORKER_CONCURRENCY  = "1"
    # D7: off unless a run needs it (S13 signs up); deploy.sh passes AUTH_SIGNUP_ENABLED (D291).
    AUTH_SIGNUP_ENABLED = var.auth_signup_enabled
    # Empty: telemetry is not exported. Headers for the collector, when it needs any, come from a secret (D290).
    OTLP_ENDPOINT = var.otlp_endpoint
  }
  # The scheduled jobs touch only the database and the queue (D19), so they get neither the HMAC key nor storage access.
  # The env schema requires the S3 key variables; these values sign nothing that is ever sent (D297).
  jobs_env = merge(local.runtime_env, {
    S3_ACCESS_KEY_ID     = "unused-by-the-scheduler"
    S3_SECRET_ACCESS_KEY = "unused-by-the-scheduler"
  })
  # Only the seed job gets the seed keys; the services do not need them.
  seed_secrets = {
    SEED_API_KEY       = google_secret_manager_secret.seed_api_key.secret_id
    SEED_ADMIN_API_KEY = google_secret_manager_secret.seed_admin_api_key.secret_id
  }
  operator_secrets = {
    migrate = tomap({ DATABASE_URL = google_secret_manager_secret.database_url.secret_id })
    seed    = tomap(merge({ DATABASE_URL = google_secret_manager_secret.database_url.secret_id }, local.seed_secrets))
  }
  # Read by the OpenTelemetry exporters themselves (`key=value,...`), so the env schema does not list it (D290).
  otlp_secrets = var.otlp_headers ? tomap({ OTEL_EXPORTER_OTLP_HEADERS = google_secret_manager_secret.otlp_headers[0].secret_id }) : tomap({})
  runtime_secrets = merge({
    DATABASE_URL         = google_secret_manager_secret.database_url.secret_id
    BETTER_AUTH_SECRET   = google_secret_manager_secret.auth_secret.secret_id
    S3_ACCESS_KEY_ID     = google_secret_manager_secret.hmac_access_id.secret_id
    S3_SECRET_ACCESS_KEY = google_secret_manager_secret.hmac_secret.secret_id
  }, local.otlp_secrets)
  jobs_secrets = merge({
    DATABASE_URL = google_secret_manager_secret.database_url.secret_id
  }, local.otlp_secrets)
  # Every secret an operator job reads, by variable name.
  operator_secret_ids = merge(values(local.operator_secrets)...)
}

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "compute.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "storage.googleapis.com",
    # Service accounts, the custom role and the project lookup (data.google_project) go through these two (D297).
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------- identities

# One account per role (D297): api and worker; the scheduled jobs (database and queue only, D19); the operator jobs
# (migrate and seed: the database and the seed keys); and the Cloud Scheduler caller.
resource "google_service_account" "runtime" {
  account_id   = "hostmark-runtime"
  display_name = "hostmark api and worker"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "jobs" {
  account_id   = "hostmark-jobs"
  display_name = "hostmark scheduled jobs"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "operator" {
  account_id   = "hostmark-operator"
  display_name = "hostmark migrate and seed jobs"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "scheduler" {
  account_id   = "hostmark-scheduler"
  display_name = "hostmark Cloud Scheduler caller"
  depends_on   = [google_project_service.apis]
}

# D100: the only Compute permission the runtime has; it purges the CDN of one URL map. A deleted custom role can be
# undeleted for 7 days and its ID stays taken for up to 37 (README, Destroy).
resource "google_project_iam_custom_role" "cdn_invalidate" {
  role_id     = "hostmarkCdnInvalidate"
  title       = "hostmark CDN invalidation"
  permissions = ["compute.urlMaps.invalidateCache"]
}

resource "google_project_iam_member" "runtime_invalidate" {
  project = var.project
  role    = google_project_iam_custom_role.cdn_invalidate.id
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------------------------------------------------------- queue

resource "google_pubsub_topic" "jobs" {
  name       = local.topic
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "dlq" {
  name = local.dlq_topic
}

# The dead letter queue is a topic with a pull subscription that keeps messages for 7 days, so they can be inspected.
# Nothing reads it in normal operation, so without an expiration policy it would be deleted after 31 idle days and the
# dead letters published after that would be lost.
resource "google_pubsub_subscription" "dlq" {
  name                       = "${local.dlq_topic}-reader"
  topic                      = google_pubsub_topic.dlq.id
  message_retention_duration = "604800s"
  ack_deadline_seconds       = 60
  expiration_policy {
    ttl = "" # never expires
  }
}

# D17: the ack deadline is the visibility timeout; MAX_ATTEMPTS deliveries, then Pub/Sub forwards to the dead letter topic.
# The consumer sets the backoff per message with ModifyAckDeadline, so no retry_policy here.
resource "google_pubsub_subscription" "worker" {
  name                       = local.worker_sub
  topic                      = google_pubsub_topic.jobs.id
  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"
  expiration_policy {
    ttl = "" # never expires
  }
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq.id
    max_delivery_attempts = 5
  }
}

data "google_project" "this" {}

# The Pub/Sub service agent forwards dead letters: publish to the dead letter topic, acknowledge on the source subscription.
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  topic  = google_pubsub_topic.dlq.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dlq_subscriber" {
  subscription = google_pubsub_subscription.worker.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "runtime_publisher" {
  topic  = google_pubsub_topic.jobs.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# queue.ping reads the topic metadata; publisher and subscriber do not include pubsub.topics.get (D200).
resource "google_pubsub_topic_iam_member" "runtime_viewer" {
  topic  = google_pubsub_topic.jobs.id
  role   = "roles/pubsub.viewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# cleanup-expired and requeue-stuck enqueue; the jobs never ping the queue, so no viewer role.
resource "google_pubsub_topic_iam_member" "jobs_publisher" {
  topic  = google_pubsub_topic.jobs.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.jobs.email}"
}

resource "google_pubsub_subscription_iam_member" "runtime_subscriber" {
  subscription = google_pubsub_subscription.worker.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------------------------------------------------------- storage

resource "google_storage_bucket" "media" {
  name                        = local.bucket
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # A destroy fails while the bucket holds objects; empty it first (README, Destroy).
  force_destroy = false

  # Deleted originals and variants are gone at once, as on the other platforms, instead of being kept and billed for
  # the default 7 days of soft delete (D295).
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  # D74: the safeguard from the spec. Originals and variants expire after 8 days even if the scheduler never runs.
  lifecycle_rule {
    condition {
      age            = 8
      matches_prefix = ["originals/", "variants/"]
    }
    action {
      type = "Delete"
    }
  }

  # Browser uploads go straight to the bucket with a presigned URL.
  cors {
    origin          = ["*"]
    method          = ["PUT", "GET"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }
  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "runtime" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# The XML API signs with an HMAC key of the service account (SigV4 interoperability). The secret is in the state: keep it private.
resource "google_storage_hmac_key" "runtime" {
  service_account_email = google_service_account.runtime.email
}

# ---------------------------------------------------------------- secrets

resource "google_secret_manager_secret" "database_url" {
  secret_id = "hostmark-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "auth_secret" {
  secret_id = "hostmark-auth-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# The seed job never generates keys (its output goes to Cloud Logging): scripts/deploy.sh stores both values.
resource "google_secret_manager_secret" "seed_api_key" {
  secret_id = "hostmark-seed-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "seed_admin_api_key" {
  secret_id = "hostmark-seed-admin-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Only when the deploy has OTLP_HEADERS (var.otlp_headers): the collector's credentials, never a plain variable (D290).
resource "google_secret_manager_secret" "otlp_headers" {
  count     = var.otlp_headers ? 1 : 0
  secret_id = "hostmark-otlp-headers"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "hmac_access_id" {
  secret_id = "hostmark-s3-access-key-id"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "hmac_secret" {
  secret_id = "hostmark-s3-secret-access-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "hmac_access_id" {
  secret      = google_secret_manager_secret.hmac_access_id.id
  secret_data = google_storage_hmac_key.runtime.access_id
}

resource "google_secret_manager_secret_version" "hmac_secret" {
  secret      = google_secret_manager_secret.hmac_secret.id
  secret_data = google_storage_hmac_key.runtime.secret
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.runtime_secrets
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "jobs" {
  for_each  = local.jobs_secrets
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}

# Only the operator account reads the seed keys; api and worker cannot (D297).
resource "google_secret_manager_secret_iam_member" "operator" {
  for_each  = local.operator_secret_ids
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.operator.email}"
}

# ---------------------------------------------------------------- services

resource "google_cloud_run_v2_service" "api" {
  name     = "hostmark-api"
  location = var.region
  # Only the load balancer reaches the api, so the client address header is set by the load balancer alone (D182).
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  default_uri_disabled = true
  deletion_protection  = false
  # No IAM check for invoking: ingress lets only the load balancer in, and no allUsers binding is needed (D294).
  invoker_iam_disabled = true

  template {
    service_account                  = google_service_account.runtime.email
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = 1
      max_instance_count = var.api_max_instances
    }
    containers {
      image   = var.image
      command = ["node"]
      args    = ["--enable-source-maps", "dist/api.js"]
      ports {
        container_port = 8080
      }
      # Instance-based billing: the CPU stays allocated outside requests, so the telemetry exporters, the SSE polls
      # and the shutdown run at full speed (D292). It costs the always-on instance and every instance's idle time.
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = false
      }
      dynamic "env" {
        for_each = local.runtime_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.runtime_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime, google_secret_manager_secret_version.hmac_secret]
}

# The worker is a service with manual scaling, not a worker pool (D181, D293): it keeps the /healthz startup probe.
# Instance-based billing keeps the CPU on between messages, and a fixed instance count replaces request-based
# autoscaling, which a pull consumer cannot trigger.
resource "google_cloud_run_v2_service" "worker" {
  name                 = "hostmark-worker"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  default_uri_disabled = true
  deletion_protection  = false

  # Manual scaling: exactly this many instances, whatever the traffic; revision min and max are ignored in this mode.
  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = var.worker_instances
  }

  template {
    service_account = google_service_account.runtime.email
    # No timeout: it bounds requests (here only /healthz), not shutdown. Cloud Run sends SIGKILL 10 s after SIGTERM
    # whatever is set; the worker hands back the job it holds and exits before that (src/consumer.ts, src/shutdown.ts).
    containers {
      image   = var.image
      command = ["node"]
      args    = ["--enable-source-maps", "dist/worker.js"]
      ports {
        container_port = 8080
      }
      resources {
        limits   = { cpu = "2", memory = var.worker_memory }
        cpu_idle = false
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 5
        failure_threshold = 12
      }
      dynamic "env" {
        for_each = local.runtime_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.runtime_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime, google_secret_manager_secret_version.hmac_secret]
}

# ---------------------------------------------------------------- scheduler (D181): Cloud Scheduler starts a Cloud Run Job

resource "google_cloud_run_v2_job" "scheduled" {
  for_each            = local.scheduler_jobs
  name                = "hostmark-${each.key}"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.jobs.email
      max_retries     = 0
      timeout         = "600s"
      containers {
        image   = var.image
        command = ["node"]
        args    = ["--enable-source-maps", "dist/run-job.js", each.key]
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        dynamic "env" {
          for_each = local.jobs_env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = local.jobs_secrets
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.jobs]
}

# Migrations and the seed run as one-off jobs of the same image: `gcloud run jobs execute hostmark-migrate --wait`.
# deploy.sh applies the migrate job alone and runs it before the services move to the new image (D298).
resource "google_cloud_run_v2_job" "operator" {
  for_each            = local.operator_secrets
  name                = "hostmark-${each.key}"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.operator.email
      max_retries     = 0
      timeout         = "600s"
      containers {
        image   = var.image
        command = ["node"]
        args    = ["dist/${each.key}.js"]
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        dynamic "env" {
          for_each = each.value
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.operator]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler" {
  for_each = local.scheduler_jobs
  name     = google_cloud_run_v2_job.scheduled[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "scheduled" {
  for_each  = local.scheduler_jobs
  name      = "hostmark-${each.key}"
  region    = var.region
  schedule  = each.value
  time_zone = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project}/locations/${var.region}/jobs/${google_cloud_run_v2_job.scheduled[each.key].name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------- load balancer and Cloud CDN

resource "google_compute_global_address" "lb" {
  name       = "hostmark-lb"
  depends_on = [google_project_service.apis]
}

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "hostmark-api"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "hostmark-api"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  enable_cdn            = true
  # Brotli or gzip for text responses, as the CDNs of the other platforms do (S10, D208).
  compression_mode = "AUTOMATIC"

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  # D80: set on every request from the client address the load balancer saw, replacing any value the client sent.
  custom_request_headers = ["X-Client-Ip: {client_ip_address}"]

  # The api marks /media and /f as cacheable and everything else as private or no-store, so the origin decides.
  # No default_ttl, max_ttl or client_ttl: the API refuses them with USE_ORIGIN_HEADERS (the provider strips them on
  # update for that reason). Cloud CDN then keeps a response for its s-maxage or max-age, capped by default at 30 days
  # (2,592,000 s), and passes the origin Cache-Control to the client unchanged. So /media (max-age=31536000, immutable,
  # D6) stays at most 30 days at the edge and a year in a browser; an unpublish or delete invalidates the edge (D100).
  cdn_policy {
    cache_mode = "USE_ORIGIN_HEADERS"
    # Stale copies are served at most 10 minutes past their TTL while the origin is revalidated or failing; the API
    # default is a day. Not a TTL, so the mode accepts it (D295).
    serve_while_stale = 600
    cache_key_policy {
      include_host         = true
      include_protocol     = true
      include_query_string = false
    }
  }
}

resource "google_compute_url_map" "app" {
  name            = local.url_map
  default_service = google_compute_backend_service.api.id
}

resource "google_compute_managed_ssl_certificate" "app" {
  name = "hostmark"
  managed {
    domains = [var.domain]
  }
}

resource "google_compute_target_https_proxy" "app" {
  name             = "hostmark"
  url_map          = google_compute_url_map.app.id
  ssl_certificates = [google_compute_managed_ssl_certificate.app.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "hostmark-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.app.id
  ip_address            = google_compute_global_address.lb.id
}

# Port 80 answers with a 301 to the same URL on https (D294). IPv4 only, like the https rule: an IPv6 address would
# need a second global address and two more forwarding rules.
resource "google_compute_url_map" "http_redirect" {
  name = "hostmark-http-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "http_redirect" {
  name    = "hostmark-http-redirect"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "hostmark-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "80"
  target                = google_compute_target_http_proxy.http_redirect.id
  ip_address            = google_compute_global_address.lb.id
}
