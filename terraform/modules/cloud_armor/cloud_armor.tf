module "cloud_armor_policy" {
  count   = var.enable_cloud_armor ? 1 : 0
  source  = "GoogleCloudPlatform/cloud-armor/google"
  version = "~> 5.0"

  project_id                           = var.project_id
  name                                 = local.security_policy_name
  description                          = "Cloud Armor OWASP Policies"
  default_rule_action                  = "allow"
  type                                 = "CLOUD_ARMOR"
  layer_7_ddos_defense_enable          = true
  layer_7_ddos_defense_rule_visibility = "STANDARD"

  # --- OWASP Rules ---
  pre_configured_rules = {
    owasp_crs_xss = {
      priority                = 1001
      description             = "OWASP ModSecurity CRS - Cross-Site Scripting (XSS)"
      action                  = "deny(502)"
      target_rule_set         = "xss-v33-stable"
      exclude_target_rule_ids = ["owasp-crs-v030301-id942432-sqli", "owasp-crs-v030301-id942421-sqli", "owasp-crs-v030301-id941330-xss"]
    }
    owasp_crs_lfi = {
      priority                = 1002
      description             = "OWASP ModSecurity CRS - Local File Inclusion (LFI)"
      action                  = "deny(502)"
      target_rule_set         = "lfi-v33-stable"
      exclude_target_rule_ids = ["owasp-crs-v030301-id930120-lfi"]
    }
    owasp_crs_rfi = {
      priority                = 1003
      description             = "OWASP ModSecurity CRS - Remote File Inclusion (RFI)"
      action                  = "deny(502)"
      target_rule_set         = "rfi-v33-stable"
      exclude_target_rule_ids = []
    }
    owasp_crs_rce = {
      priority                = 1004
      description             = "OWASP ModSecurity CRS - Remote Code Execution (RCE)"
      action                  = "deny(502)"
      target_rule_set         = "rce-v33-stable"
      exclude_target_rule_ids = []
    }
    owasp_crs_php = {
      priority                = 1005
      description             = "OWASP ModSecurity CRS - PHP Injection"
      action                  = "deny(502)"
      target_rule_set         = "php-v33-stable"
      exclude_target_rule_ids = []
    }
    owasp_crs_java = {
      priority                = 1006
      description             = "OWASP ModSecurity CRS - Java Injection"
      action                  = "deny(502)"
      target_rule_set         = "java-v33-stable"
      exclude_target_rule_ids = []
    }
    owasp_crs_nodejs = {
      priority                = 1007
      description             = "OWASP ModSecurity CRS - NodeJS Injection"
      action                  = "deny(502)"
      target_rule_set         = "nodejs-v33-stable"
      exclude_target_rule_ids = []
    }
    owasp_crs_session_fixation = {
      priority                = 1008
      description             = "OWASP ModSecurity CRS - Session Fixation"
      action                  = "deny(502)"
      target_rule_set         = "sessionfixation-v33-stable"
      exclude_target_rule_ids = []
    }
    owasp_crs_scanner_detection = {
      priority                = 1009
      description             = "OWASP ModSecurity CRS - Scanner Detection"
      action                  = "deny(502)"
      target_rule_set         = "scannerdetection-v33-stable"
      exclude_target_rule_ids = []
    }
    owasp_crs_protocol_enforcement = {
      priority                = 1010
      description             = "OWASP ModSecurity CRS - Method Enforcement"
      action                  = "deny(502)"
      target_rule_set         = "methodenforcement-v33-stable"
      exclude_target_rule_ids = ["owasp-crs-v030301-id911100-methodenforcement"]
    }
    owasp_crs_protocol_attack = {
      priority                = 1011
      description             = "OWASP ModSecurity CRS - Protocol Attack"
      action                  = "deny(502)"
      target_rule_set         = "protocolattack-v33-stable"
      exclude_target_rule_ids = ["owasp-crs-v030301-id921150-protocolattack"]
    }
  }
}