module "google_project_service" {
  source         = "./modules/google_project_service"
  gcp_project_id = var.gcp_project_id
  gcp_service_list = [
    "container.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "clouddeploy.googleapis.com",
    "file.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "iap.googleapis.com"
  ]
}

provider "kubernetes" {
  host                   = module.gke_cluster.cluster_endpoint
  cluster_ca_certificate = base64decode(module.gke_cluster.cluster_ca_certificate)
  token                  = module.gke_cluster.access_token
}

module "gke_cluster" {
  source      = "./modules/gke_cluster"
  environment = var.environment
  prefix      = var.prefix
  gcp_region  = var.gcp_region
  application = var.application
}

module "iap" {
  source               = "./modules/iap"
  environment          = var.environment
  application          = var.application
  iap_access_members   = ["group:go-genai-studio-user@goreply.de"]
  security_policy_name = var.enable_cloud_armor ? module.cloud_armor.security_policy_name : ""
  project_id           = var.gcp_project_id
  prefix               = var.prefix
}

module "cloudbuild_v2_github" {
  source = "github.com/kasna-cloud/terraform-google-cloud-build-gen-2"

  create_connection = true # set to true once the secrets are added

  connection_name     = "${var.environment}-${var.application}"
  connection_location = var.gcp_region
  project_id          = var.gcp_project_id
  installation_id     = 63043800

  repositories = {
    github = "https://github.com/go-reply-de/go-genai-studio.git"
  }
  git_provider = "github"
}

module "cloudbuild" {
  source = "./modules/cloudbuild"

  gcp_region  = var.gcp_region
  prefix      = var.prefix
  environment = var.environment
  node_env    = var.node_env
  application = var.application
  git_push_config = {
    branch = (var.git_push_config.trigger_type == "branch" ? var.git_push_config.value : null)
    tag    = (var.git_push_config.trigger_type == "tag" ? var.git_push_config.value : null)
  }

  filename      = "cloudbuild.yaml"
  repository_id = module.cloudbuild_v2_github.repository_ids["github"]

  cluster_id                            = module.gke_cluster.cluster_id
  k8s_secret_private_key_name           = module.gke_cluster.k8s_secret_private_key_name
  domain                                = var.domain
  librechat_credentials_env_keys        = module.gke_cluster.librechat_credentials_env_keys
  librechat_credentials_env_keys_prefix = module.gke_cluster.librechat_credentials_env_keys_prefix
  ip_address_id                         = module.gke_cluster.ip_address_id
  security_policy                       = var.enable_cloud_armor ? module.cloud_armor.security_policy_name : ""
}


module "monitoring" {
  source = "./modules/monitoring"

  gcp_project_id    = var.gcp_project_id
  gcp_region        = var.gcp_region
  email_address     = var.application_email
  uptime_check_host = var.domain
  application       = var.application
  environment       = var.environment
  gke_cluster_name  = module.gke_cluster.cluster_name
  security_policy   = var.enable_cloud_armor ? module.cloud_armor.security_policy_name : ""
}

module "gcs_bucket" {
  source = "./modules/storage_bucket"

  name            = "${var.gcp_project_id}_genai-studio-images_${var.environment}"
  location        = var.gcp_region
  user_group_mail = var.user_group_mail
}

module "configmap" {
  source = "./modules/configmap"

  yaml_file_path         = "../k8s/librechat.tf.tpl"
  sign_in_domains        = var.sign_in_domains
  cluster_endpoint       = module.gke_cluster.cluster_endpoint
  cluster_ca_certificate = module.gke_cluster.cluster_ca_certificate
  access_token           = module.gke_cluster.access_token
  namespace              = "${var.application}-${var.environment}"
  domain                 = var.domain
  application_name       = var.application_name
  application_date       = var.application_date
  application_email      = var.application_email
}

module "cloud_armor" {
  source = "./modules/cloud_armor"

  project_id         = var.gcp_project_id
  environment        = var.environment
  application        = var.application
  enable_cloud_armor = var.enable_cloud_armor
}
