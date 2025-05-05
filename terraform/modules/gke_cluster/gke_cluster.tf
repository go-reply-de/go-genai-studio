resource "google_compute_network" "gke_cluster" {
  name = "${var.application}-${var.environment}"

  auto_create_subnetworks  = false
  enable_ula_internal_ipv6 = true
}

resource "google_compute_subnetwork" "gke_cluster" {
  name = "${var.prefix}-${var.environment}-${var.application}"

  ip_cidr_range = "10.0.0.0/16"
  region        = var.gcp_region

  stack_type       = "IPV4_IPV6"
  ipv6_access_type = "EXTERNAL"

  network = google_compute_network.gke_cluster.id
  secondary_ip_range {
    range_name    = "services-range"
    ip_cidr_range = "192.168.0.0/24"
  }

  secondary_ip_range {
    range_name    = "pod-ranges"
    ip_cidr_range = "192.168.1.0/24"
  }
}

resource "google_compute_firewall" "default" {
  name    = "${var.prefix}-${var.environment}-${var.application}-web"
  network = google_compute_network.gke_cluster.name

  allow {
    protocol = "icmp"
  }

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_tags = ["web"]
}

resource "google_compute_global_address" "ip_address" {
  name = "${var.prefix}-${var.environment}-${var.application}"
}

resource "google_container_cluster" "gke_cluster" {
  name = "${var.prefix}-${var.environment}-${var.application}"

  location                 = var.gcp_region
  enable_autopilot         = true
  enable_l4_ilb_subsetting = true

  network    = google_compute_network.gke_cluster.id
  subnetwork = google_compute_subnetwork.gke_cluster.id

  ip_allocation_policy {
    stack_type                    = "IPV4_IPV6"
    services_secondary_range_name = google_compute_subnetwork.gke_cluster.secondary_ip_range[0].range_name
    cluster_secondary_range_name  = google_compute_subnetwork.gke_cluster.secondary_ip_range[1].range_name
  }

  # Set `deletion_protection` to `true` will ensure that one cannot
  # accidentally delete this instance by use of Terraform.
  deletion_protection = false
}