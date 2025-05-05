resource "google_storage_bucket" "go-genai-images-bucket" {
  name     = var.name
  location = var.location

  uniform_bucket_level_access = false // Enable object-level ACLs
}

resource "google_storage_bucket_iam_member" "bucket_group_access" {
  for_each = toset(var.user_group_mail)
  bucket = google_storage_bucket.go-genai-images-bucket.name
  role   = "roles/storage.objectUser" // Adjust the role as needed
  member = "group:${each.key}"
}
