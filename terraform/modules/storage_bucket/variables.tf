variable "name" {
  description = "The name of the storage bucket"
  type        = string
}

variable "location" {
  description = "The location of the storage bucket"
  type        = string
}

variable "user_group_mail" {
  description = "The emails of the user groups to grant access to the storage bucket"
  type        = list(string)
}