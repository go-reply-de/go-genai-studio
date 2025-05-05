terraform {
  source = "../..//terraform"
}

include {
  merge_strategy = "deep"
  path           = find_in_parent_folders("root.hcl")
}

inputs = {

  node_env        = "development"
  domain          = "dev.genai-studio.goreply.de"
  sign_in_domains = ["goreply.de", "demo.goreply.de"]

  git_push_config = {
    trigger_type = "branch"
    value        = "^master$"
  }

  user_group_mail = ["go-genai-studio-developers.group@goreply.de", "go-genai-studio-user@goreply.de"]

  # Cloud Armor configuration
  enable_cloud_armor = true
}
