variable "cluster_endpoint" {
  type        = string
  description = "The endpoint of the GKE cluster."
}

variable "cluster_ca_certificate" {
  type        = string
  description = "The CA certificate of the GKE cluster."
}

variable "access_token" {
  type = string
}

variable "application" {
  type = string

  validation {
    condition     = length(var.application) > 3
    error_message = "Provide valid application name longer than 3 characters"
  }
}

variable "application_name" {
  type = string
  description = "The full application name."
  default = "Go GenAI Studio"
}

variable "environment" {
  type = string
}

variable "security_policy_name" {
  type = string
}

variable "gcp_project_id" {
  type        = string
  description = "The ID of the Google Cloud Project."
}

variable "domain" {
  type        = string
  description = "The domain name."
}

variable "iap_support_email" {
  type        = string
  description = "The E-Mail address of a user in your GCP."
}

variable "iap_group" {
  type        = string
}
