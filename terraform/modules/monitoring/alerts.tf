resource "google_monitoring_alert_policy" "go_genai_alerts" {
  for_each = { for alert in local.go_genai_studio_alerts : alert.display_name => alert }

  display_name = each.value.display_name
  documentation {
    mime_type = "text/markdown"
    content   = each.value.documentation_content
    subject   = each.value.documentation_subject
  }
  project = var.gcp_project_id
  conditions {
    display_name = each.value.condition_display_name
    condition_threshold {
      aggregations {
        alignment_period     = each.value.alignment_period
        per_series_aligner   = each.value.per_series_aligner
        cross_series_reducer = lookup(each.value, "cross_series_reducer", null)
        group_by_fields      = lookup(each.value, "group_by_fields", null)
      }
      comparison              = "COMPARISON_GT"
      duration                = each.value.duration
      evaluation_missing_data = lookup(each.value, "evaluation_missing_data", null)
      filter                  = each.value.filter
      threshold_value         = each.value.threshold_value
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    auto_close = "604800s"
  }
  combiner              = "OR"
  enabled               = length(regexall("prod", var.environment)) > 0
  notification_channels = each.value.notification_channels
  severity              = each.value.severity
}

resource "google_monitoring_notification_channel" "email_channel" {
  display_name = "Alert for Go GenAI Studio"
  type         = "email"
  labels = {
    email_address = var.email_address
  }
  project = var.gcp_project_id
}

resource "google_monitoring_uptime_check_config" "uptime_check" {
  display_name = "${var.application}-${var.environment}"
  timeout      = "10s"

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.gcp_project_id
      host       = var.uptime_check_host
    }
  }

  http_check {
    path           = "/login"
    port           = 443
    request_method = "GET"
    use_ssl        = true
    validate_ssl   = true

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
    accepted_response_status_codes {
      status_value = 301
    }
    accepted_response_status_codes {
      status_value = 302
    }
  }

  period = "60s"

}