import { describe, it, expect } from "vitest";
import { acceptanceRateFrom } from "./aggregation-queries";
import {
  isAcceptanceEligibleFeature,
  isAgentFeature,
  isCliFeature,
  isCompletionFeature,
} from "@/lib/aggregation/separate-metrics";

/**
 * `copilot_cli` used to match no classification predicate at all, so its
 * generations and acceptances were dropped from the acceptance rate while
 * remaining in nothing else either. On a CLI-heavy fleet that turned a real
 * ~77% acceptance rate into a red 12.5% card.
 */
describe("copilot_cli classification", () => {
  it("is recognised as a CLI feature", () => {
    expect(isCliFeature("copilot_cli")).toBe(true);
  });

  it("is not an IDE completion feature", () => {
    // Its LoC must stay out of completion LoC — the CLI writes files directly
    // rather than offering suggestions a human accepts.
    expect(isCompletionFeature("copilot_cli")).toBe(false);
  });

  it("is not an agent feature", () => {
    expect(isAgentFeature("copilot_cli")).toBe(false);
  });

  it("counts toward the acceptance rate", () => {
    // Unlike agent_edit, the CLI reports real acceptance events, so excluding
    // it understates the rate rather than protecting it.
    expect(isAcceptanceEligibleFeature("copilot_cli")).toBe(true);
  });

  it("still excludes agent_edit from the acceptance rate", () => {
    // agent_edit always reports zero acceptances, so including it can only
    // deflate the rate.
    expect(isAcceptanceEligibleFeature("agent_edit")).toBe(false);
  });

  it("keeps IDE completion features eligible", () => {
    expect(isAcceptanceEligibleFeature("code_completion")).toBe(true);
    expect(isAcceptanceEligibleFeature("chat_panel_ask_mode")).toBe(true);
  });
});

describe("acceptanceRateFrom", () => {
  it("divides completion + CLI acceptances by completion + CLI generations", () => {
    const rate = acceptanceRateFrom({
      compAcceptCount: 14386,
      compGenCount: 76882,
      cliAcceptCount: 505032,
      cliGenCount: 515769,
    });

    expect(rate).toBeCloseTo(((14386 + 505032) / (76882 + 515769)) * 100, 6);
    expect(rate).toBeGreaterThan(70);
  });

  it("returns 0 rather than NaN when nothing was generated", () => {
    expect(
      acceptanceRateFrom({
        compAcceptCount: 0,
        compGenCount: 0,
        cliAcceptCount: 0,
        cliGenCount: 0,
      }),
    ).toBe(0);
  });

  it("treats missing CLI counts as zero, so pre-CLI rows still work", () => {
    expect(acceptanceRateFrom({ compAcceptCount: 15, compGenCount: 20 })).toBe(75);
  });

  it("never exceeds 100 for well-formed counts", () => {
    expect(
      acceptanceRateFrom({
        compAcceptCount: 20,
        compGenCount: 20,
        cliAcceptCount: 5,
        cliGenCount: 5,
      }),
    ).toBe(100);
  });
});
