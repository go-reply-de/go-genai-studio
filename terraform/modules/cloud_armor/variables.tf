variable "project_id" {
  type        = string
  description = "The ID of the Google Cloud project."
}

variable "environment" {
  type = string
}

variable "application" {
  type = string
}

variable "enable_cloud_armor" {
  type        = bool
  default     = false
  description = "Whether to enable Cloud Armor."
}