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

variable "application" {
  type = string

  validation {
    condition     = length(var.application) > 3
    error_message = "Provide valid application name longer than 3 characters"
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
#ref: librechat-credentials-env
variable "librechat_credentials_env_keys" {
  type    = list(string)
  default = ["CREDS_IV", "CREDS_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "JWT_REFRESH_SECRET", "JWT_SECRET", "MEILI_MASTER_KEY", "POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER", "SONAR_HOST", "SONAR_LOGIN", "OPENAI_API_KEY", "GOOGLE_SEARCH_API_KEY", "GOOGLE_CSE_ID"]
}