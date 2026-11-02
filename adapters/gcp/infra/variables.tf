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
