resource "google_gke_backup_restore_plan" "genai_studio_restore_plan" {
  cluster     = var.gke_cluster_id
  location    = var.gcp_region
  name        = "${var.environment}-genai-studio-restore-plan"
  description = "Restore plan for MongoDB, Postgres, and Meilisearch workloads."

  # Reference the backup plan from which restore operations will source data.
  backup_plan = google_gke_backup_backup_plan.genai_studio_backup_plan.id

  restore_config {
    cluster_resource_conflict_policy = "USE_EXISTING_VERSION"
    namespaced_resource_restore_mode = "DELETE_AND_RESTORE" # Delete existing resource, then restore backup's version
    volume_data_restore_policy       = "RESTORE_VOLUME_DATA_FROM_BACKUP"
    selected_namespaces {
      namespaces = [var.namespace]
    }
  }

  labels = {
    env     = var.environment
    purpose = "data-recovery"
  }
}
