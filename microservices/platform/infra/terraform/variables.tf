variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-8192"
}

variable "api_image" {
  type = string
}

variable "api_max_instances" {
  description = "Cap so instances × db pool (4) stays ≤ 80% of Cloud SQL max_connections."
  type        = number
  default     = 20
}
