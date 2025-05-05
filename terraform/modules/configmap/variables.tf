variable "yaml_file_path" {
  type        = string
  default     = "../k8s/config.tf.tpl"
  description = "Path to the YAML file to update."
}

variable "sign_in_domains" {
  type        = list(string)
  description = "A list of domain names."

  validation {
    condition = alltrue([
      for domain in var.sign_in_domains :
      can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$", domain))
    ])
    error_message = "Invalid domain name format. Each entry should be a valid fully qualified domain name (FQDN)."
  }
}

variable "cluster_endpoint" {
  type        = string
  description = "The endpoint of the GKE cluster."
}

variable "cluster_ca_certificate" {
  type        = string
  description = "The CA certificate of the GKE cluster."
}

variable "application_name" {
  type        = string
  description = "The non-technical, formatted application name."
}

variable "application_email" {
  type        = string
  description = "The e-mail address of the admins."
}

variable "application_date" {
  type        = string
  description = "The date when the new terms of service would be applied."
}

variable "access_token" {
  type = string
}

variable "namespace" {
  type = string
}

variable "domain" {
  type = string
}