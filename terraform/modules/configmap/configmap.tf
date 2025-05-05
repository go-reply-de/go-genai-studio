provider "kubernetes" {
  host                   = var.cluster_endpoint
  cluster_ca_certificate = base64decode(var.cluster_ca_certificate)
  token                  = var.access_token
}

resource "kubernetes_config_map" "config" {

  metadata {
    name      = "config"
    namespace = var.namespace
    labels = {
      app = "api"
    }
  }
  data = {
    "config.yaml" = trimspace(local.config_content)
  }

  lifecycle {
    create_before_destroy = true
  }
}