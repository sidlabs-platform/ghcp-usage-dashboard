import { NextResponse } from "next/server";
import {
  getDashboardConfig,
  isEnterpriseEnabled,
  getEffectiveBillingEnabled,
  isBillingSubEnabled,
  isCopilotSubEnabled,
  isImpactSubEnabled,
  getImpactConfig,
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

  const impactEnabled = config.metrics.impact.enabled;

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
    // Impact pages — each individually toggleable
    impactOverview: impactEnabled && isImpactSubEnabled("executiveSummary"),
    impactPrEfficiency: impactEnabled && isImpactSubEnabled("prEfficiency"),
    impactAgentImpact: impactEnabled && isImpactSubEnabled("agentImpact"),
    impactLicenseUtilization: impactEnabled && isImpactSubEnabled("licenseUtilization"),
    impactCodeReviewImpact: impactEnabled && isImpactSubEnabled("codeReviewImpact"),
    impactRoiScore: impactEnabled && isImpactSubEnabled("roiScore"),
    impactTimeToValue: impactEnabled && isImpactSubEnabled("timeToValue"),
    impactAdoptionFunnel: impactEnabled && isImpactSubEnabled("adoptionFunnel"),
    impactEngagementDepth: impactEnabled && isImpactSubEnabled("engagementDepth"),
    impactMaturityJourney: impactEnabled && isImpactSubEnabled("maturityJourney"),
    impactHealthScore: impactEnabled && isImpactSubEnabled("healthScore"),
    impactAgentAutonomy: impactEnabled && isImpactSubEnabled("agentAutonomy"),
    impactCostPerValue: impactEnabled && isImpactSubEnabled("costPerValue"),
    impactVersionCompliance: impactEnabled && isImpactSubEnabled("versionCompliance"),
  };

  return NextResponse.json({
    ...config,
    enterpriseMode,
    multiEnterprise: isMultiEnterprise(),
    enterprises: getClientEnterpriseList(),
    effectiveBilling: billingEnabled,
    resolvedOrgs: getResolvedOrgs(),
    pageVisibility,
    impactConfig: impactEnabled ? getImpactConfig() : null,
  });
}
