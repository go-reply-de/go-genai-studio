resource "google_gke_backup_backup_plan" "genai_studio_backup_plan" {
  cluster     = var.gke_cluster_id
  location    = var.gcp_region
  name        = "${var.environment}-genai-studio-backup-plan"
  description = "Daily backup plan for MongoDB, Postgres, and Meilisearch workloads"

  retention_policy {
    backup_delete_lock_days = 7
    backup_retain_days      = 30
  }

  backup_config {
    include_volume_data = true
    include_secrets     = true
    selected_namespaces {
      namespaces = [var.namespace]
    }
  }

  backup_schedule {
    rpo_config {
      target_rpo_minutes = 1440
      exclusion_windows {
        start_time {
          hours   = 1 # Start exclusion right after our allowed 00:00-01:00 UTC window
          minutes = 0
          seconds = 0
          nanos   = 0
        }
        # The duration covers 23 hours (82800 seconds),
        # effectively excluding until 00:00 UTC the next day.
        duration = "82800s" # 23 hours

        # Make this a daily recurring exclusion
        daily = true
      }
    }
  }

  labels = {
    env     = var.environment
    purpose = "data-protection"
  }
}
