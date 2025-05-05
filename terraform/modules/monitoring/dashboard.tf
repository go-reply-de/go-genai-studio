resource "google_monitoring_dashboard" "go_genai_studio_dashboard" {
  dashboard_json = jsonencode({
    displayName = "${var.application}-(${var.environment})"
    mosaicLayout = {
      columns = 48
      tiles = [
        for idx, dashboard in local.go_genai_studio_dashboard : {
          xPos   = lookup(dashboard, "tile_x_pos", null)
          yPos   = lookup(dashboard, "tile_y_pos", null)
          width  = lookup(dashboard, "tile_width", null)
          height = lookup(dashboard, "tile_height", null)
          widget = {
            title = dashboard.widget_title

            logsPanel = contains(keys(dashboard), "logs_panel_filter") ? {
              filter = dashboard.logs_panel_filter
              resourceNames = [
                "projects/${var.gcp_project_id}/locations/global/logScopes/_Default"
              ]
            } : null

            xyChart = contains(keys(dashboard), "data_sets") ? {
              dataSets = [
                for ds in coalesce(lookup(dashboard, "data_sets", []), []) : {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = ds.time_series_filter
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = lookup(ds, "per_series_aligner", null)
                        crossSeriesReducer = "REDUCE_SUM"
                        groupByFields      = lookup(ds, "group_by_fields", [])
                      }
                    }
                    outputFullDuration = false
                  }
                  plotType           = "LINE"
                  legendTemplate     = lookup(ds, "legend_template", null)
                  targetAxis         = "Y1"
                  minAlignmentPeriod = "60s"
                }
              ]
              yAxis = {
                scale = "LINEAR"
              }
              xAxis = {
                scale = "LINEAR"
              }
              chartOptions = {
                mode              = "COLOR"
                showLegend        = false
                displayHorizontal = false
              }
            } : null

            alertChart = contains(keys(dashboard), "alert_chart_name") ? {
              name = dashboard.alert_chart_name
            } : null

            incidentList = contains(keys(dashboard), "policy_names") ? {
              policyNames = dashboard.policy_names
              groupBy     = "GROUP_BY_TYPE_UNSPECIFIED"
            } : null

            errorReportingPanel = contains(keys(dashboard), "error_reporting_panel") ? {
              projectNames = [
                "projects/${var.gcp_project_id}"
              ]
              services = coalesce(lookup(dashboard.error_reporting_panel, "services", []), [])
            } : null
          }
        }
      ]
    }
  })
}