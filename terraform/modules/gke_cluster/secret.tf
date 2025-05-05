resource "google_service_account" "k8s_service_account" {
  account_id = "${var.application}-${var.environment}-k8s-sa"
}

resource "google_project_iam_member" "act_as" {
  project = data.google_project.project.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.k8s_service_account.email}"
}

resource "google_project_iam_member" "logs_writer" {
  project = data.google_project.project.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.k8s_service_account.email}"
}
resource "google_project_iam_member" "discoveryengine_viewer" {
  project = data.google_project.project.project_id
  role    = "roles/discoveryengine.viewer"
  member  = "serviceAccount:${google_service_account.k8s_service_account.email}"
}
resource "google_project_iam_member" "aiplatform_user" {
  project = data.google_project.project.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.k8s_service_account.email}"
}

resource "google_service_account_key" "k8s_key" {
  service_account_id = google_service_account.k8s_service_account.name
  public_key_type    = "TYPE_X509_PEM_FILE"
}

resource "google_secret_manager_secret" "k8s_key_private_key" {
  secret_id = "${var.prefix}-${var.environment}-${var.application}-k8s_key_private_key"

  replication {
    user_managed {
      replicas {
        location = var.gcp_region
      }
    }
  }
}

resource "google_secret_manager_secret_version" "k8s_key_private_key_version" {
  secret_data = base64decode(google_service_account_key.k8s_key.private_key)
  secret      = google_secret_manager_secret.k8s_key_private_key.id
}

resource "google_secret_manager_secret" "librechat_credentials_env" {
  count     = length(var.librechat_credentials_env_keys)
  secret_id = "${local.librechat_credentials_env_keys_prefix}${var.librechat_credentials_env_keys[count.index]}"

  replication {
    user_managed {
      replicas {
        location = var.gcp_region
      }
    }
  }
}