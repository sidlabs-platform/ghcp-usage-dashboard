import { NextResponse } from "next/server";
import {
  getDashboardConfig,
  isEnterpriseEnabled,
  getEffectiveBillingEnabled,
  isBillingSubEnabled,
  isCopilotSubEnabled,
  getResolvedOrgs,
  type BillingMetricConfig,
} from "@/lib/config/dashboard-config";
import {
  getClientEnterpriseList,
  isMultiEnterprise,
  isMetricEnabledForAnyEnterprise,
  isCopilotSubEnabledForAnyEnterprise,
  isBillingSubEnabledForAnyEnterprise,
  isLicensingHistoryEnabledForAnyEnterprise,
  getClientEnterpriseMetrics,
} from "@/lib/config/enterprise-config";

export async function GET() {
  const config = getDashboardConfig();
  const enterpriseMode = isEnterpriseEnabled();
  const multiEnt = isMultiEnterprise();

  // In multi-enterprise mode, use "any enterprise" checks for page visibility
  // so a page shows if at least one enterprise has the metric enabled
  const copilotEnabled = multiEnt
    ? isMetricEnabledForAnyEnterprise("copilot")
    : config.metrics.copilot.enabled;
  const userMetrics = copilotEnabled && (multiEnt
    ? isCopilotSubEnabledForAnyEnterprise("userMetrics")
    : isCopilotSubEnabled("userMetrics"));
  const billingEnabled = multiEnt
    ? isMetricEnabledForAnyEnterprise("billing")
    : getEffectiveBillingEnabled();
  const securityEnabled = multiEnt
    ? (isMetricEnabledForAnyEnterprise("codeScanning") ||
       isMetricEnabledForAnyEnterprise("dependabot") ||
       isMetricEnabledForAnyEnterprise("secretScanning"))
    : (config.metrics.codeScanning?.enabled ||
       config.metrics.dependabot?.enabled ||
       config.metrics.secretScanning?.enabled);

  const pageVisibility = {
    overview: copilotEnabled,
    codeGeneration: userMetrics,
    chatModes: userMetrics,
    adoptionCohorts: userMetrics,
    models: userMetrics,
    cli: userMetrics,
    pullRequests: copilotEnabled && (multiEnt
      ? isCopilotSubEnabledForAnyEnterprise("pullRequests")
      : isCopilotSubEnabled("pullRequests")),
    teams: userMetrics && (multiEnt
      ? isCopilotSubEnabledForAnyEnterprise("teams")
      : isCopilotSubEnabled("teams")),
    users: userMetrics,
    seats: copilotEnabled && (multiEnt
      ? isCopilotSubEnabledForAnyEnterprise("seats")
      : isCopilotSubEnabled("seats")),
    ideLanguages: userMetrics,
    security: securityEnabled,
    billing: billingEnabled,
    billingUsage: billingEnabled && (multiEnt
      ? isBillingSubEnabledForAnyEnterprise("meteredUsage")
      : isBillingSubEnabled("meteredUsage")),
    billingPremium: billingEnabled && (multiEnt
      ? (isBillingSubEnabledForAnyEnterprise("premiumRequests") || isBillingSubEnabledForAnyEnterprise("aiCredits"))
      : (isBillingSubEnabled("premiumRequests") || isBillingSubEnabled("aiCredits"))),
    licenseReconciliation: billingEnabled && (multiEnt
      ? (isBillingSubEnabledForAnyEnterprise("premiumRequests") || isBillingSubEnabledForAnyEnterprise("aiCredits"))
      : (isBillingSubEnabled("premiumRequests") || isBillingSubEnabled("aiCredits"))),
    aiCreditsUsers: userMetrics,
  };

  // `metrics.billing.licensing` is a server-only configuration block (audit
  // archive/identity-map/snapshot directory paths, AI-Credit CSV import
  // path, report-month ranges, etc.) — it must never reach the browser.
  // Nothing on the client reads it (only `metrics.<category>.enabled` and
  // `pageVisibility` are consumed — see `src/app/dashboard/page.tsx` and
  // `src/components/layout/Sidebar.tsx`), so it is stripped entirely here
  // rather than relying on an incomplete per-field denylist. Every other
  // billing sub-toggle (`enabled`/`meteredUsage`/`premiumRequests`/
  // `aiCredits`) is preserved unchanged for backward compatibility.
  const { licensing: _licensing, ...safeBilling } = config.metrics.billing as BillingMetricConfig;
  const safeMetrics = { ...config.metrics, billing: safeBilling };

  return NextResponse.json({
    ...config,
    metrics: safeMetrics,
    enterpriseMode,
    multiEnterprise: multiEnt,
    enterprises: getClientEnterpriseList(),
    enterpriseMetrics: getClientEnterpriseMetrics(),
    effectiveBilling: billingEnabled,
    // Safe, computed summary of whether historical license reconciliation
    // is enabled anywhere (globally, or overridden on for at least one
    // enterprise) — never the underlying `LicensingConfig` itself.
    licensingHistoryEnabled: isLicensingHistoryEnabledForAnyEnterprise(),
    resolvedOrgs: getResolvedOrgs(),
    pageVisibility,
  });
}
