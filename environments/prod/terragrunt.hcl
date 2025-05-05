terraform {
  source = "../..//terraform"
}

include {
  merge_strategy = "deep"
  path           = find_in_parent_folders("root.hcl")
}

inputs = {

  node_env        = "production"
  domain          = "genai-studio.goreply.de"
  sign_in_domains = ["goreply.de", "charite.goreply.de", "aenova.goreply.de"]

  git_push_config = {
    trigger_type = "tag"
    value        = "v*"
  }

  user_group_mail = ["go-genai-studio-user@goreply.de"]
}
