resource "google_clouddeploy_target" "primary" {
  location = var.gcp_region
  name     = "${var.prefix}-${var.environment}-${var.application}"

  gke {
    cluster = var.cluster_id
  }

  require_approval = false
}

resource "google_clouddeploy_delivery_pipeline" "primary" {
  location = var.gcp_region
  name     = "${var.prefix}-${var.environment}-${var.application}"

  serial_pipeline {
    stages {
      target_id = google_clouddeploy_target.primary.target_id
    }
  }
}