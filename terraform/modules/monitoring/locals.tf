locals {
  uptime_failure_display_name      = "[${upper(var.environment)}] Go GenAI Studio - Uptime Failure"
  uptime_failure_alert_policy_name = google_monitoring_alert_policy.go_genai_alerts[local.uptime_failure_display_name].name
  uptime_failure_alert_policy_id   = element(split("/", google_monitoring_alert_policy.go_genai_alerts[local.uptime_failure_display_name].name), 1)
  uptime_check_id                  = regex("uptimeCheckConfigs/(.*)", google_monitoring_uptime_check_config.uptime_check.id)[0]
  email_channel_name               = google_monitoring_notification_channel.email_channel.name
  go_genai_studio_dashboard = [
    {
      tile_y_pos        = 76
      tile_width        = 48
      tile_height       = 26
      widget_title      = "API ${upper(var.environment)} Logs"
      logs_panel_filter = "resource.type=\"k8s_container\"\nresource.labels.project_id=\"${var.gcp_project_id}\"\nresource.labels.location=\"${var.gcp_region}\"\nresource.labels.cluster_name=\"${var.gke_cluster_name}\"\nresource.labels.namespace_name=\"${var.application}-${var.environment}\"\nlabels.k8s-pod/app=\"api\" \n\n"
    },
    {
      tile_y_pos        = 187
      tile_width        = 48
      tile_height       = 16
      widget_title      = "Cloud Armor Logs ${upper(var.environment)}"
      logs_panel_filter = "resource.type = (\"http_load_balancer\" OR \"tcp_ssl_proxy_rule\" OR \"l4_proxy_rule\") AND jsonPayload.enforcedSecurityPolicy.name = \"${var.security_policy}\" AND resource.labels.project_id=\"${var.gcp_project_id}\"\nseverity=\"WARNING\""
    },
    {
      tile_y_pos   = 102
      tile_x_pos   = 32
      tile_width   = 13
      tile_height  = 17
      widget_title = "API Storage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/used_bytes\" AND resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/total_bytes\" AND resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_y_pos   = 102
      tile_x_pos   = 16
      tile_width   = 13
      tile_height  = 17
      widget_title = "API Memory Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/used_bytes\" AND metric.labels.memory_type=\"non-evictable\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/request_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/limit_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_y_pos   = 102
      tile_width   = 13
      tile_height  = 17
      widget_title = "API CPU Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/core_usage_time\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\""
          per_series_aligner = "ALIGN_RATE"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/request_cores\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/limit_cores\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"api\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_y_pos   = 27
      tile_width   = 48
      tile_height  = 16
      widget_title = "API Container - Uptime"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/uptime\" resource.type=\"k8s_container\" resource.labels.cluster_name=\"${var.gke_cluster_name}\" metadata.user_labels.\"app\"=\"api\""
          per_series_aligner = "ALIGN_MEAN"
        }
      ]
    },
    {
      tile_height  = 14
      tile_width   = 48
      widget_title = "Incidents"
      policy_names = ["alertPolicies/${local.uptime_failure_alert_policy_id}"]
    },
    {
      tile_y_pos   = 43
      tile_width   = 48
      tile_height  = 17
      widget_title = "API Container Restarts"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/restart_count\" resource.type=\"k8s_container\" resource.label.\"cluster_name\"=\"${var.gke_cluster_name}\" metadata.user_labels.\"app\"=\"api\""
          per_series_aligner = "ALIGN_RATE"
        }
      ]
    },
    {
      tile_y_pos   = 60
      tile_width   = 48
      tile_height  = 16
      widget_title = "API Error Reporting Panel"
      error_reporting_panel = {
        services = ["api"]
      }
    },
    {
      tile_y_pos       = 14
      tile_height      = 13
      tile_width       = 48
      widget_title     = "Uptime Failures"
      alert_chart_name = "${local.uptime_failure_alert_policy_name}"
    },
    {
      tile_y_pos   = 136
      tile_width   = 13
      tile_height  = 17
      widget_title = "MongoDB CPU Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/core_usage_time\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\""
          per_series_aligner = "ALIGN_RATE"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/request_cores\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/limit_cores\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_x_pos   = 16
      tile_y_pos   = 136
      tile_width   = 13
      tile_height  = 17
      widget_title = "MongoDB Memory Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/used_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/request_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/limit_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_x_pos   = 32
      tile_y_pos   = 136
      tile_width   = 13
      tile_height  = 17
      widget_title = "MongoDB Storage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/used_bytes\" AND resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/total_bytes\" AND resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"mongodb\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_y_pos   = 153
      tile_width   = 13
      tile_height  = 17
      widget_title = "Meilisearch CPU Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/core_usage_time\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\""
          per_series_aligner = "ALIGN_RATE"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/request_cores\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/limit_cores\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_x_pos   = 16
      tile_y_pos   = 153
      tile_width   = 13
      tile_height  = 17
      widget_title = "Meilisearch Memory Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/used_bytes\" AND metric.labels.memory_type=\"non-evictable\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/request_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/limit_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_x_pos   = 32
      tile_y_pos   = 153
      tile_width   = 13
      tile_height  = 17
      widget_title = "Meilisearch Storage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/used_bytes\" AND resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/total_bytes\" AND resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"meilisearch\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_x_pos   = 32
      tile_y_pos   = 119
      tile_width   = 13
      tile_height  = 17
      widget_title = "VectorDB Storage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/used_bytes\" resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/pod/volume/total_bytes\" resource.type=\"k8s_pod\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_y_pos   = 119
      tile_width   = 13
      tile_height  = 17
      widget_title = "VectorDB CPU Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/core_usage_time\" resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\""
          per_series_aligner = "ALIGN_RATE"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/request_cores\" resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/limit_cores\" resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_x_pos   = 16
      tile_y_pos   = 119
      tile_width   = 13
      tile_height  = 17
      widget_title = "VectorDB Memory Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/used_bytes\" AND metric.labels.memory_type=\"non-evictable\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/request_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/limit_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"vectordb-${var.environment}\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_y_pos   = 170
      tile_width   = 13
      tile_height  = 17
      widget_title = "RAG CPU Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/core_usage_time\" resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"rag\""
          per_series_aligner = "ALIGN_RATE"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/request_cores\" resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"rag\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/cpu/limit_cores\" resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"rag\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    },
    {
      tile_x_pos   = 16
      tile_y_pos   = 170
      tile_width   = 13
      tile_height  = 17
      widget_title = "RAG Memory Usage"
      data_sets = [
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/used_bytes\" AND metric.labels.memory_type=\"non-evictable\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"rag\""
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Used"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/request_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"rag\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Requested"
        },
        {
          time_series_filter = "metric.type=\"kubernetes.io/container/memory/limit_bytes\" AND resource.type=\"k8s_container\" AND resource.labels.project_id=\"${var.gcp_project_id}\" AND resource.labels.location=\"${var.gcp_region}\" AND resource.labels.cluster_name=\"${var.gke_cluster_name}\" AND resource.labels.namespace_name=\"${var.application}-${var.environment}\" AND metadata.system_labels.top_level_controller_type=\"Deployment\" AND metadata.system_labels.top_level_controller_name=\"rag\"",
          per_series_aligner = "ALIGN_MEAN"
          legend_template    = "Limit"
        }
      ]
    }
  ]

  go_genai_studio_alerts = [
    {
      display_name           = "[${upper(var.environment)}] Go GenAI Studio - API Container Restarts"
      condition_display_name = "GKE container in ${var.gke_cluster_name} has been restarted"
      alignment_period       = "300s"
      per_series_aligner     = "ALIGN_DELTA"
      duration               = "0s"
      filter                 = "resource.type = \"k8s_container\" AND (resource.labels.cluster_name = \"${var.gke_cluster_name}\" AND resource.labels.location = \"${var.gcp_region}\" AND resource.labels.namespace_name = \"${var.application}-${var.environment}\") AND metric.type = \"kubernetes.io/container/restart_count\" AND metadata.user_labels.app = \"api\""
      threshold_value        = 3
      auto_close             = "604800s"
      notification_channels  = [local.email_channel_name]
      severity               = "WARNING"
      documentation_content  = "* Container restarts are commonly caused by memory/cpu usage issues and application failures.\n* By default, this alert notifies an incident when there is more than 1 container restart in a 5 minute window. If alerts tend to be false positive or noisy, consider visiting the alert policy page and changing the threshold, the rolling (alignment) window, and the retest (duration) window. [View Documentation](https://cloud.google.com/monitoring/alerts/concepts-indepth).\n"
      documentation_subject  = "Alert for Go GenAI Studio - API Container Restarts"
    },
    {
      display_name           = "[${upper(var.environment)}] Go GenAI Studio - Meilisearch Disk Space"
      condition_display_name = "Kubernetes Meilisearch ${upper(var.environment)} Pod - Volume usage"
      alignment_period       = "60s"
      per_series_aligner     = "ALIGN_MEAN"
      duration               = "0s"
      filter                 = "resource.type = \"k8s_pod\" AND (resource.labels.cluster_name = \"${var.gke_cluster_name}\" AND resource.labels.location = \"${var.gcp_region}\" AND resource.labels.namespace_name = \"${var.application}-${var.environment}\") AND metric.type = \"kubernetes.io/pod/volume/used_bytes\" AND metric.labels.persistentvolumeclaim_name = \"meilisearch-claim0\""
      threshold_value        = 9655555000
      notification_channels  = [local.email_channel_name]
      severity               = "CRITICAL"
      documentation_content  = "Meilisearch ${upper(var.environment)} Pod Volume Reached Threshold"
      documentation_subject  = "Alert for Go GenAI Studio - Meilisearch ${upper(var.environment)} Pod Volume"
    },
    {
      display_name           = "${local.uptime_failure_display_name}"
      condition_display_name = "Uptime Check ${local.uptime_check_id} Failed."
      alignment_period       = "60s"
      per_series_aligner     = "ALIGN_NEXT_OLDER"
      cross_series_reducer   = "REDUCE_COUNT_FALSE"
      group_by_fields = [
        "resource.label.project_id",
        "resource.label.host"
      ]
      evaluation_missing_data = "EVALUATION_MISSING_DATA_INACTIVE"
      duration                = "60s"
      filter                  = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"${local.uptime_check_id}\" AND resource.label.\"host\"=\"${var.uptime_check_host}\""
      threshold_value         = 1
      notification_channels   = [local.email_channel_name]
      severity                = "CRITICAL"
      documentation_content   = "Uptime check failed for Go GenAI Studio - ${upper(var.environment)}."
      documentation_subject   = "Go GenAI Studio is down."
    }
  ]
}