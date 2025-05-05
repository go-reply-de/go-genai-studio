locals {
  config_content = templatefile(var.yaml_file_path, {
    app_domain      = var.domain
    app_name        = var.application_name
    date            = var.application_date
    email           = var.application_email
    allowed_domains = var.sign_in_domains
  })
}