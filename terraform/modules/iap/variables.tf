variable "application" {
  type = string

  validation {
    condition     = length(var.application) > 3
    error_message = "Provide valid application name longer than 3 characters"
  }
}

variable "environment" {
  type = string
}

variable "prefix" {
  type = string
}

variable "project_id" {
  type = string
}

variable "security_policy_name" {
  type = string
}

variable "iap_access_members" {
  description = "A list of members to grant access via IAP. Must be prefixed with 'user:', 'group:', 'serviceAccount:', or 'domain:'."
  type        = list(string)
  default     = []
}