output "ip_address" {
  value = module.gke_cluster.ip_address_id
}

output "repo_name" {
  value = module.cloudbuild.repo_name
}