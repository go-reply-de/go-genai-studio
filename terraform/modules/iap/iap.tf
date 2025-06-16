# Creating K8s Namespace
resource "kubernetes_namespace" "application_namespace" {
  metadata {
    name = "${var.application}-${var.environment}"
    labels = {
      environment = var.environment
      application = var.application
      created_by  = "terraform"
    }
  }
}

#resource "google_project_service" "iap_service" {
#  project = var.gcp_project_id
#  service = "iap.googleapis.com"
#}
#
#resource "google_iap_brand" "project_brand" {
#  project           = var.gcp_project_id
#  support_email     = var.iap_support_email
#  application_title = var.application_name
#  depends_on        = [google_project_service.iap_service]
#}
#
#resource "google_iap_client" "project_client" {
#  display_name = "${var.application_name} IAP Client"
#  brand        = google_iap_brand.project_brand.name
#  depends_on   = [google_iap_brand.project_brand]
#}

resource "kubernetes_secret" "iap_oauth_secret" {
  metadata {
    name      = "iap-oauth-credentials"
    namespace = kubernetes_namespace.application_namespace.metadata[0].name
  }
  data = {
    client_id     = local.oauth.client_id
    client_secret = local.oauth.client_secret
  }
  type = "Opaque"
}

resource "kubernetes_manifest" "iap_backend_config" {
  manifest = {
    "apiVersion" = "cloud.google.com/v1"
    "kind"       = "BackendConfig"
    "metadata" = {
      "name"      = "genai-studio-managed-ingress-${var.environment}-backend-config"
      "namespace" = kubernetes_namespace.application_namespace.metadata[0].name
    }
    "spec" = {
      "timeoutSec" = 300
      "securityPolicy" = {
        "name" = var.security_policy_name
      }
      "iap" = {
        "enabled" = true
        "oauthclientCredentials" = {
          "secretName" = kubernetes_secret.iap_oauth_secret.metadata[0].name
        }
      }
    }
  }
  depends_on = [kubernetes_secret.iap_oauth_secret]
}

resource "google_project_iam_binding" "iap_binding" {
  project             = var.project_id
  role                = "roles/iap.httpsResourceAccessor"
  members             = var.iap_access_members
}