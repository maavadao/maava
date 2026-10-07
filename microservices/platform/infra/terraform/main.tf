# Phase 0 skeleton — serverless GCP stack per PLAN.md §2.
# No Redis/Memorystore, no GKE, no VPC connectors in V1.

terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  # backend "gcs" { bucket = "mawadao-agent-platform-tfstate" prefix = "prod" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ---------- Cloud SQL (Postgres) ----------
resource "google_sql_database_instance" "main" {
  name             = "mawadao-agent-platform-${var.env}"
  database_version = "POSTGRES_16"
  settings {
    tier = var.db_tier
    ip_configuration {
      ipv4_enabled = true # Cloud Run connects via the Cloud SQL connector
    }
    # Managed connection pooling is enabled via the API/console until the
    # provider exposes it; DB connection budget: instances × pool ≤ 80% of
    # max_connections (see PLAN.md serverless rules).
  }
  deletion_protection = true
}

resource "google_sql_database" "app" {
  name     = "mawadao_agent_platform"
  instance = google_sql_database_instance.main.name
}

# ---------- Artifacts bucket ----------
resource "google_storage_bucket" "artifacts" {
  name                        = "mawadao-agent-platform-${var.env}-artifacts"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # uploads-tmp/ cleanup lives mid-path (tenants/{org}/uploads-tmp/), which GCS
  # lifecycle matches_prefix cannot target — the Phase 2 janitor job owns it.
  # Nearline/Coldline transitions for old versions and tool-outputs: Phase 2.
}

# ---------- Service accounts ----------
resource "google_service_account" "api" {
  account_id   = "ap-api-${var.env}"
  display_name = "mawaDao Agent Platform API"
}

resource "google_service_account" "scan" {
  account_id   = "ap-scan-${var.env}"
  display_name = "Skill scan/extract service"
}

# ---------- API service (Cloud Run) ----------
resource "google_cloud_run_v2_service" "api" {
  name     = "ap-api-${var.env}"
  location = var.region

  template {
    service_account = google_service_account.api.email
    scaling {
      min_instance_count = 1  # kills cold starts, keeps caches warm
      max_instance_count = var.api_max_instances
    }
    timeout                          = "3600s" # long streamed chats
    max_instance_request_concurrency = 40      # agent loops are I/O-bound
    containers {
      image = var.api_image
      resources {
        cpu_idle = false # CPU always-allocated: required for SSE streaming
      }
      env {
        name  = "AP_ENV"
        value = var.env
      }
    }
  }
}

# TODO(phase 2): Eventarc trigger GCS finalize -> scan/extract Cloud Run service
# TODO(phase 2+): Cloud Scheduler -> Cloud Run Jobs: bucket janitor,
#                 mcp schema refresh, mcp health checks, GDPR hard-delete
# TODO: Secret Manager secrets (openrouter key, db app password) + IAM bindings
