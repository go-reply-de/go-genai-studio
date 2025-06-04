data "google_iam_policy" "iap" {
  binding {
    role = "roles/iap.httpsResourceAccessor"
    members = [
      "group:${var.iap_group}",
    ]
  }
}