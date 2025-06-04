locals {
  # The length of application name, environment and gcp_project_id combined can at most be 46  characters long
  application = "go-genai-studio"

  team_name       = "goreply"
  repository      = "internal_internal-projects_go-genai-studio"
  prefix          = "go-de"
  domain          = "example.com"
  sign_in_domains = ["customer.com"]

  # Extract the variables we need for easy access
  gcp_region     = "europe-west3"
  gcp_project_id = "go-de-genai-studio"

  # Due to the setup of the environments directory it will match the corresponding environment
  environment = "${path_relative_to_include()}"

  # Configmap variables
  application_name  = "Go GenAI Studio"
  application_email = "go.de.genai.studio@reply.de"
  application_date  = formatdate("MMMM DD, YYYY", timestamp())
}

# Configure Terragrunt to automatically store tfstate files in an S3 bucket
remote_state {
  backend = "gcs"

  config = {
    #######################################################################
    #  IMPORTANT NOTE:                                                    #
    #  We are making use of the structure of the environments directory.  #
    #  The foldername should match the actual environment.                #
    #######################################################################

    bucket   = "terraform-state-${local.environment}-${local.application}-${local.gcp_project_id}"
    prefix   = "terraform.tfstate"
    project  = "${local.gcp_project_id}"
    location = "${local.gcp_region}"
  }
}

generate "terraform" {
  path      = "terraform.tf"
  if_exists = "overwrite"
  contents  = <<EOF
terraform {
  backend "gcs" {}
  required_version = ">= 1.6.3"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 4.0.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.20" # Or your preferred recent version
    }
  }
}

provider "google" {
  project = "${local.gcp_project_id}"
  region = "${local.gcp_region}"
  default_labels = {
    application         = "${local.application}"
    environment         = "${local.environment}"
    team_name           = "${local.team_name}"
    repository          = "${local.repository}"
  }
}

EOF
}
#prevent_destroy = true

inputs = {
  gcp_project_id    = "${local.gcp_project_id}"
  gcp_region        = "${local.gcp_region}"
  prefix            = "${local.prefix}"
  environment       = "${local.environment}"
  application       = "${local.application}"
  domain            = "${local.domain}"
  sign_in_domains   = "${local.sign_in_domains}"
  application_name  = "${local.application_name}"
  application_date  = "${local.application_date}"
  application_email = "${local.application_email}"
}
