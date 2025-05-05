output "cluster_id" {
  value       = google_container_cluster.gke_cluster.id
  description = "an identifier for the cluster with format `projects/{{project}}/locations/{{zone}}/clusters/{{name}}`"
}

output "cluster_name" {
  value       = google_container_cluster.gke_cluster.name
  description = "an identifier for the cluster name"
}

output "cluster_endpoint" {
  value       = "https://${google_container_cluster.gke_cluster.endpoint}"
  description = "The endpoint of the GKE cluster."
}

output "cluster_ca_certificate" {
  value       = google_container_cluster.gke_cluster.master_auth[0].cluster_ca_certificate
  description = "The CA certificate of the GKE cluster."
}

output "k8s_secret_private_key_name" {
  value       = split("/", google_secret_manager_secret.k8s_key_private_key.name)[length(split("/", google_secret_manager_secret.k8s_key_private_key.name)) - 1] #Get part behind the last /
  description = "K8S secret base64 encoded"
}

output "librechat_credentials_env_keys" {
  value = [for name in google_secret_manager_secret.librechat_credentials_env.*.name :
  split("/", name)[length(split("/", name)) - 1]]
  description = "Keys of the librechat_credentials_env secret"
}

output "librechat_credentials_env_keys_prefix" {
  value = local.librechat_credentials_env_keys_prefix
}
output "ip_address" {
  value = google_compute_global_address.ip_address.self_link
}
output "ip_address_id" {
  value = split("/", google_compute_global_address.ip_address.id)[length(split("/", google_compute_global_address.ip_address.id)) - 1] #Get part behind the last /
}

output "access_token" {
  value = data.google_client_config.default.access_token
}