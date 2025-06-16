data "google_secret_manager_secret_version" "client_id" {
  project = var.project_id
  secret  = "${var.prefix}-${var.environment}-${var.application}-GOOGLE_CLIENT_ID"
}

data "google_secret_manager_secret_version" "client_secret" {
  project = var.project_id
  secret  = "${var.prefix}-${var.environment}-${var.application}-GOOGLE_CLIENT_SECRET"
}