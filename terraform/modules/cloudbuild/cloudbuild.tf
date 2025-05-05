resource "google_cloudbuild_trigger" "repo-trigger" {
  name     = "${var.prefix}-${var.environment}-${var.application}"
  location = var.gcp_region

  repository_event_config {
    repository = var.repository_id

    #Conditionally create the push block
    dynamic "push" {
      for_each = var.git_push_config.branch != null || var.git_push_config.tag != null ? [1] : []
      content {
        branch = var.git_push_config.branch
        tag    = var.git_push_config.tag
      }
    }
  }
  depends_on = [
    google_project_iam_member.act_as,
    google_project_iam_member.logs_writer
  ]
  service_account = google_service_account.cloudbuild_service_account.id
  substitutions = {
    _GKE_CLUSTER_NAME                      = google_clouddeploy_target.primary.target_id
    _REGISTRY_NAME                         = google_artifact_registry_repository.repo.name
    _DELIVERY_PIPELINE_NAME                = google_clouddeploy_delivery_pipeline.primary.name
    _GKE_NAMESPACE                         = "${var.application}-${var.environment}"
    _LIBRECHAT_CREDENTIALS_ENV_KEYS        = join(",", var.librechat_credentials_env_keys)
    _LIBRECHAT_CREDENTIALS_ENV_KEYS_PREFIX = var.librechat_credentials_env_keys_prefix
    _K8S_SECRET_PRIVATE_KEY_NAME           = var.k8s_secret_private_key_name
    _DOMAIN                                = var.domain
    _IP_ADDRESS_ID                         = var.ip_address_id
    _ENVIRONMENT                           = var.environment
    _NODE_ENV                              = var.node_env
    _SECURITY_POLICY                       = var.security_policy
  }
  filename = var.filename
}

resource "google_service_account" "cloudbuild_service_account" {
  account_id = "${var.application}-${var.environment}-build-sa"
}

resource "google_project_iam_member" "act_as" {
  project = data.google_project.project.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.cloudbuild_service_account.email}"
}

resource "google_project_iam_member" "logs_writer" {
  project = data.google_project.project.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloudbuild_service_account.email}"
}
resource "google_project_iam_member" "repo_writer" {
  project = data.google_project.project.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.cloudbuild_service_account.email}"
}
resource "google_project_iam_member" "k8s_developer" {
  project = data.google_project.project.project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:${google_service_account.cloudbuild_service_account.email}"
}
#clouddeploy.targets.update
#clouddeploy.deliveryPipelines.update
resource "google_project_iam_member" "clouddeploy_operator" {
  project = data.google_project.project.project_id
  role    = "roles/clouddeploy.operator"
  member  = "serviceAccount:${google_service_account.cloudbuild_service_account.email}"
}
#storage.buckets.create
#storage.objects.create
resource "google_project_iam_member" "cloudbuil_builder" {
  project = data.google_project.project.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${google_service_account.cloudbuild_service_account.email}"
}
#secretmanager.versions.access
resource "google_project_iam_member" "secretmanager_secret_accessor" {
  project = data.google_project.project.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.cloudbuild_service_account.email}"
}

resource "google_artifact_registry_repository" "repo" {
  location      = var.gcp_region
  repository_id = "${var.prefix}-${var.environment}-${var.application}"
  format        = "DOCKER"

  docker_config {
    immutable_tags = false
  }
}