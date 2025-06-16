locals {
  oauth = {
    client_id     = data.google_secret_manager_secret_version.client_id.secret_data
    client_secret = data.google_secret_manager_secret_version.client_secret.secret_data
  }
}