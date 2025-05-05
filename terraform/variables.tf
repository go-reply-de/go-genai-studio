variable "prefix" {
  type = string

  validation {
    condition     = length(var.prefix) > 2
    error_message = "Provide valid prefix longer than 2 characters."
  }
}

variable "environment" {
  type = string
}

variable "node_env" {
  type = string

  validation {
    condition     = contains(["development", "production"], var.node_env)
    error_message = "Provide NODE_ENV variable as in LibreChat either production or development"
  }
}

variable "application" {
  type = string

  validation {
    condition     = length(var.application) > 3
    error_message = "Provide valid application name longer than 3 characters"
  }
}

variable "gcp_project_id" {
  type        = string
  description = "The ID of the Google Cloud Project."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.gcp_project_id))
    error_message = "The project ID must start with a lowercase letter, be between 6 and 30 characters long, contain only lowercase letters, numbers, and hyphens, and end with a lowercase letter or number."
  }
}

variable "gcp_region" {
  type        = string
  description = "The Google Cloud region for resources."

  validation {
    condition     = can(regex("^[a-z]{2,12}-[a-z]+[0-9]{1}$", var.gcp_region))
    error_message = "Invalid GCP region. Please choose from the available regions."
  }
}

variable "domain" {
  type        = string
  description = "The domain name."

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$", var.domain))
    error_message = "Invalid domain name format.  It should be a valid fully qualified domain name (FQDN)."
  }
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

variable "git_push_config" {
  type = object({
    trigger_type = string # either "branch" or "tag"
    value        = string
  })
  description = "Configuration for the Git push event."
}

variable "user_group_mail" {
  description = "The emails of the user groups to grant access to the storage bucket"
  type        = list(string)
}

variable "enable_cloud_armor" {
  type        = bool
  default     = false
  description = "Whether to enable Cloud Armor."
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