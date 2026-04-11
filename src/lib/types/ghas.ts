// TypeScript types for GitHub Advanced Security (GHAS) metrics
// Based on: https://docs.github.com/en/rest/code-scanning, /rest/dependabot, /rest/secret-scanning

// ── Code Scanning (GitHub API) ────────────────────────────────────────

export interface CodeScanningAlertRule {
  id: string;
  severity: string;
  security_severity_level: string | null;
  description: string;
}

export interface CodeScanningAlertTool {
  name: string;
  version: string | null;
}

export interface CodeScanningAutofix {
  status: string;
}

export interface CodeScanningAlert {
  number: number;
  state: string;
  created_at: string;
  updated_at: string;
  fixed_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  rule: CodeScanningAlertRule;
  tool: CodeScanningAlertTool;
  most_recent_instance?: {
    ref: string;
    state: string;
  };
  autofix?: CodeScanningAutofix;
  html_url: string;
  repository?: { full_name: string };
}

// ── Dependabot (GitHub API) ───────────────────────────────────────────

export interface DependabotVulnerability {
  package: { ecosystem: string; name: string };
  severity: string;
  first_patched_version: { identifier: string } | null;
}

export interface DependabotAlert {
  number: number;
  state: string;
  created_at: string;
  updated_at: string;
  fixed_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  auto_dismissed_at: string | null;
  security_vulnerability: DependabotVulnerability;
  html_url: string;
  repository?: { full_name: string };
}

// ── Secret Scanning (GitHub API) ──────────────────────────────────────

export interface SecretScanningAlert {
  number: number;
  state: string;
  secret_type: string;
  secret_type_display_name: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution: string | null;
  html_url: string;
  repository?: { full_name: string };
}

// ── Daily Aggregates (DB storage / UI consumption) ────────────────────

export interface CodeScanningDaily {
  day: string;
  scope: string;
  scope_id: string;
  opened: number;
  fixed: number;
  dismissed: number;
  reopened: number;
  total_open: number;
  severity_critical: number;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  autofix_available: number;
  autofix_committed: number;
}

export interface DependabotDaily {
  day: string;
  scope: string;
  scope_id: string;
  opened: number;
  fixed: number;
  dismissed: number;
  auto_dismissed: number;
  total_open: number;
  severity_critical: number;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  ecosystem_counts: Record<string, number>;
}

export interface SecretScanningDaily {
  day: string;
  scope: string;
  scope_id: string;
  opened: number;
  resolved: number;
  total_open: number;
  resolution_counts: Record<string, number>;
}

// ── Security Overview (dashboard summary cards) ───────────────────────

export interface SecurityOverview {
  codeScanning: {
    totalOpen: number;
    criticalOpen: number;
    highOpen: number;
    fixedLast30d: number;
    openedLast30d: number;
    autofixAvailable: number;
    autofixCommitted: number;
    mttrDays: number | null;
    fixRate: number;
  } | null;
  dependabot: {
    totalOpen: number;
    criticalOpen: number;
    highOpen: number;
    fixedLast30d: number;
    openedLast30d: number;
    mttrDays: number | null;
    fixRate: number;
    topEcosystems: { ecosystem: string; count: number }[];
  } | null;
  secretScanning: {
    totalOpen: number;
    resolvedLast30d: number;
    openedLast30d: number;
    mttrDays: number | null;
    resolutionBreakdown: Record<string, number>;
  } | null;
}

// ── GHAS Sync State ───────────────────────────────────────────────────

export interface GhasSyncState {
  scope: string;
  scope_id: string;
  metric_type: string;
  last_synced_at: string;
  last_alert_updated_at: string | null;
  total_alerts: number;
  status: string;
  error_message: string | null;
}
