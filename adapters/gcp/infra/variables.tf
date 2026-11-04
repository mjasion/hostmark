variable "project" {
  type        = string
  description = "Google Cloud project id. An empty project that only holds this benchmark is recommended."
}

variable "region" {
  type        = string
  default     = "europe-west3"
  description = "Region of Cloud Run, Pub/Sub storage preference and the bucket (Frankfurt, like the other platforms)."
}

variable "domain" {
  type        = string
  description = "Public host name served by the load balancer. Its DNS A record must point at the `lb_ip` output."
}

variable "image" {
  type        = string
  description = "Artifact Registry image that holds dist/ of this adapter, built from adapters/gcp/Dockerfile."
}

variable "bucket_name" {
  type        = string
  default     = null
  description = "Bucket for originals and variants. Default: <project>-hostmark."
}

variable "app_version" {
  type    = string
  default = "dev"
}

variable "worker_instances" {
  type        = number
  default     = 2
  description = "Worker instances, each with WORKER_CONCURRENCY=1 (D97). Cloud Run scales services by requests, so this is fixed."
}

variable "worker_memory" {
  type    = string
  default = "4Gi"
}

variable "api_max_instances" {
  type    = number
  default = 10
}

variable "auth_signup_enabled" {
  type        = string
  default     = "false"
  description = "AUTH_SIGNUP_ENABLED of the api. D7: off on a deployment unless a run needs it; scenario S13 signs up, so a run that includes it sets \"true\"."
  validation {
    condition     = contains(["true", "false"], var.auth_signup_enabled)
    error_message = "auth_signup_enabled must be \"true\" or \"false\"."
  }
}

variable "otlp_endpoint" {
  type        = string
  default     = ""
  description = "OTLP/HTTP base URL that the api, the worker and the scheduled jobs export telemetry to. Empty: no export."
}

variable "otlp_headers" {
  type        = bool
  default     = false
  description = "Creates the secret hostmark-otlp-headers and passes it as OTEL_EXPORTER_OTLP_HEADERS. deploy.sh sets it when OTLP_HEADERS is set and stores the value."
}
