// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LicenseBilledBreakdown } from "./LicenseBilledBreakdown";
import type { CopilotBillingBreakdown, ConsumptionSkuBreakdown } from "@/lib/types/billing";

function consumptionSku(overrides: Partial<ConsumptionSkuBreakdown>): ConsumptionSkuBreakdown {
  return {
    sku: "copilot-usage",
    label: "Copilot usage",
    unit: "ai-credits",
    quantity: 100,
    poolQuantity: 60,
    additionalQuantity: 40,
    grossCost: 10,
    discountAmount: 6,
    netCost: 4,
    ...overrides,
  };
}

function breakdown(consumptionSkus: ConsumptionSkuBreakdown[]): CopilotBillingBreakdown {
  return {
    startDate: "2026-05-01",
    endDate: "2026-05-31",
    period: "2026-05",
    seatSkus: [],
    consumptionSkus,
    orgs: [],
    daily: [{ day: "2026-05-01", seatCostNet: 0, consumptionCostNet: 4, totalNet: 4 }],
    poolCredits: 60,
    additionalCredits: 40,
    additionalCreditCostNet: 4,
    hasBilledData: true,
  };
}

describe("LicenseBilledBreakdown", () => {
  afterEach(() => cleanup());

  it("labels each consumption unit group without implying all rows are AI credits", () => {
    render(
      <LicenseBilledBreakdown
        breakdown={breakdown([
          consumptionSku({ unit: "ai-credits", label: "Copilot agent" }),
          consumptionSku({ unit: "requests", label: "Legacy premium requests", quantity: 14, poolQuantity: 0, additionalQuantity: 14 }),
          consumptionSku({ unit: "token-units", label: "Token usage", quantity: 83, poolQuantity: 0, additionalQuantity: 83 }),
          consumptionSku({ unit: "mystery-units", label: "New usage", quantity: 2, poolQuantity: 0, additionalQuantity: 2 }),
        ])}
        windowLabel="May 2026"
      />,
    );

    expect(screen.getByRole("heading", { name: /consumption by surface/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /ai credits by surface/i })).not.toBeInTheDocument();
    expect(screen.getByText("AI credits")).toBeInTheDocument();
    expect(screen.getByText("Premium requests")).toBeInTheDocument();
    expect(screen.getByText("Token units")).toBeInTheDocument();
    expect(screen.getByText("mystery-units")).toBeInTheDocument();
  });

  it("does not render pool-split copy or legend for non-credit consumption units", () => {
    render(
      <LicenseBilledBreakdown
        breakdown={breakdown([
          consumptionSku({ unit: "requests", label: "Legacy premium requests", quantity: 14, poolQuantity: 0, additionalQuantity: 14 }),
        ])}
        windowLabel="May 2026"
      />,
    );

    expect(screen.getByText("Premium requests")).toBeInTheDocument();
    expect(screen.queryByText(/entitlement pool/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/derived/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/above pool/i)).not.toBeInTheDocument();
  });
});
