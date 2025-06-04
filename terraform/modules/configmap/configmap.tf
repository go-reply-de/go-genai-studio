resource "kubernetes_config_map" "config" {

  metadata {
    name      = "config"
    namespace = var.namespace
    labels = {
      app = "api"
    }
  }
  data = {
    "librechat.yaml" = trimspace(local.config_content)
  }

  lifecycle {
    create_before_destroy = true
  }
}