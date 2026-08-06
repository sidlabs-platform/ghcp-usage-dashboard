import { NextResponse } from "next/server";
import {
  getDashboardConfig,
  isEnterpriseEnabled,
  getEffectiveBillingEnabled,
  isBillingSubEnabled,
  isCopilotSubEnabled,
  getResolvedOrgs,
} from "@/lib/config/dashboard-config";
import {
  getClientEnterpriseList,
  isMultiEnterprise,
  isMetricEnabledForAnyEnterprise,
  isCopilotSubEnabledForAnyEnterprise,
  isBillingSubEnabledForAnyEnterprise,
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
    aiCreditsUsers: userMetrics,
  };

  return NextResponse.json({
    ...config,
    enterpriseMode,
    multiEnterprise: multiEnt,
    enterprises: getClientEnterpriseList(),
    enterpriseMetrics: getClientEnterpriseMetrics(),
    effectiveBilling: billingEnabled,
    resolvedOrgs: getResolvedOrgs(),
    pageVisibility,
  });
}
