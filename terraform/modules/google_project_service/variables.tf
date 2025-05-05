variable "gcp_project_id" {
  type        = string
  description = "The ID of the Google Cloud Project."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.gcp_project_id))
    error_message = "The project ID must start with a lowercase letter, be between 6 and 30 characters long, contain only lowercase letters, numbers, and hyphens, and end with a lowercase letter or number."
  }
}
variable "gcp_service_list" {
  description = "The list of apis necessary for the project"
  type        = list(string)
  default = [
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com"
  ]
}