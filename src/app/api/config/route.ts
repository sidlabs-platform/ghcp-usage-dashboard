import { NextResponse } from "next/server";
import {
  getDashboardConfig,
  isEnterpriseEnabled,
  getEffectiveBillingEnabled,
  isBillingSubEnabled,
  isCopilotSubEnabled,
  getResolvedOrgs,
} from "@/lib/config/dashboard-config";
import { getClientEnterpriseList, isMultiEnterprise } from "@/lib/config/enterprise-config";

export async function GET() {
  const config = getDashboardConfig();
  const enterpriseMode = isEnterpriseEnabled();

  // Compute effective page visibility
  const copilotEnabled = config.metrics.copilot.enabled;
  const userMetrics = copilotEnabled && isCopilotSubEnabled("userMetrics");
  const billingEnabled = getEffectiveBillingEnabled();

  const securityEnabled =
    config.metrics.codeScanning?.enabled ||
    config.metrics.dependabot?.enabled ||
    config.metrics.secretScanning?.enabled;

  const pageVisibility = {
    overview: copilotEnabled,
    codeGeneration: userMetrics,
    chatModes: userMetrics,
    models: userMetrics,
    cli: userMetrics,
    pullRequests: copilotEnabled,
    teams: userMetrics && isCopilotSubEnabled("teams"),
    users: userMetrics,
    seats: copilotEnabled && isCopilotSubEnabled("seats"),
    ideLanguages: userMetrics,
    security: securityEnabled,
    billing: billingEnabled,
    billingUsage: billingEnabled && isBillingSubEnabled("meteredUsage"),
    billingPremium: billingEnabled && isBillingSubEnabled("premiumRequests"),
  };

  return NextResponse.json({
    ...config,
    enterpriseMode,
    multiEnterprise: isMultiEnterprise(),
    enterprises: getClientEnterpriseList(),
    effectiveBilling: billingEnabled,
    resolvedOrgs: getResolvedOrgs(),
    pageVisibility,
  });
}
