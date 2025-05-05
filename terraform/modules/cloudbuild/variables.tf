variable "prefix" {
  type = string

  validation {
    condition     = length(var.prefix) > 2
    error_message = "Provide valid prefix longer than 2 characters."
  }
}
variable "repository_id" {
  type = string
}
variable "filename" {
  type = string
}

variable "cluster_id" {
  type = string
}
variable "k8s_secret_private_key_name" {
  type = string
}



variable "gcp_region" {
  type        = string
  description = "The Google Cloud region for resources."

  validation {
    condition     = can(regex("^[a-z]{2,12}-[a-z]+[0-9]{1}$", var.gcp_region))
    error_message = "Invalid GCP region. Please choose from the available regions."
  }
}

variable "git_push_config" {
  type = object({
    branch = optional(string)
    tag    = optional(string) #  Allow for tag-based triggers as well
  })
  description = "Configuration for the Git push event."
  default = {
    branch = "master"
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

variable "domain" {
  type        = string
  description = "The domain name."

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$", var.domain))
    error_message = "Invalid domain name format.  It should be a valid fully qualified domain name (FQDN)."
  }
}

#ref: librechat-credentials-env
variable "librechat_credentials_env_keys" {
  type = list(string)
}
variable "librechat_credentials_env_keys_prefix" {
  type = string
}
variable "ip_address_id" {
  type = string
}
variable "security_policy" {
  type = string
  default = ""
}
