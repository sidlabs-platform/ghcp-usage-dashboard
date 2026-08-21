import { describe, it, expect } from "vitest";
import { skuLabel, skuKind } from "./sku-labels";

describe("skuLabel", () => {
  it("labels known seat SKUs", () => {
    expect(skuLabel("copilot_business")).toBe("Copilot Business");
    expect(skuLabel("copilot_enterprise")).toBe("Copilot Enterprise");
    expect(skuLabel("copilot_enterprise_seat")).toBe("Copilot Enterprise");
  });

  it("normalizes separators and case before matching", () => {
    expect(skuLabel("Copilot-Business")).toBe("Copilot Business");
    expect(skuLabel("COPILOT_ENTERPRISE")).toBe("Copilot Enterprise");
    expect(skuLabel("copilot business")).toBe("Copilot Business");
  });

  it("labels agentic consumption surfaces", () => {
    expect(skuLabel("copilot_coding_agent_ai_credit")).toBe("Cloud agent");
    expect(skuLabel("copilot_code_review_ai_credit")).toBe("Code review");
    expect(skuLabel("copilot_code_quality")).toBe("Code quality");
  });

  it("prefers the specific surface over the generic plan name", () => {
    // A surface SKU that also mentions a plan must not be filed as a seat.
    expect(skuLabel("copilot_enterprise_code_review")).toBe("Code review");
    expect(skuLabel("copilot_business_coding_agent")).toBe("Cloud agent");
    expect(skuLabel("copilot_enterprise_code_quality")).toBe("Code quality");
  });

  it("humanises an unrecognised SKU instead of bucketing it as Other", () => {
    expect(skuLabel("copilot_brand_new_surface")).toBe("Brand new surface");
    expect(skuLabel("something_else_entirely")).toBe("Something else entirely");
  });

  it("humanises prototype member names as plain strings", () => {
    expect(skuLabel("constructor")).toBe("Constructor");
    expect(skuLabel("toString")).toBe("Tostring");
    expect(skuLabel("valueOf")).toBe("Valueof");
    expect(skuLabel("hasOwnProperty")).toBe("Hasownproperty");
  });

  it("never returns an empty label", () => {
    expect(skuLabel("")).toBe("Unspecified");
    expect(skuLabel("   ")).toBe("Unspecified");
    expect(skuLabel(null)).toBe("Unspecified");
    expect(skuLabel(undefined)).toBe("Unspecified");
  });
});

describe("skuKind", () => {
  it("classifies seat SKUs", () => {
    expect(skuKind("copilot_business_seat")).toBe("seat");
    expect(skuKind("copilot_enterprise")).toBe("seat");
  });

  it("classifies consumption SKUs", () => {
    expect(skuKind("copilot_ai_credit")).toBe("consumption");
    expect(skuKind("copilot_premium_request")).toBe("consumption");
    expect(skuKind("copilot_token_units")).toBe("consumption");
  });

  it("treats a credit SKU that also names a plan as consumption", () => {
    expect(skuKind("copilot_enterprise_ai_credit")).toBe("consumption");
  });

  it("defaults unknown SKUs to consumption", () => {
    expect(skuKind("mystery_sku")).toBe("consumption");
    expect(skuKind("")).toBe("consumption");
  });

  it("handles prototype member names without throwing", () => {
    expect(() => skuKind("constructor")).not.toThrow();
    expect(() => skuKind("toString")).not.toThrow();
    expect(() => skuKind("valueOf")).not.toThrow();
    expect(() => skuKind("hasOwnProperty")).not.toThrow();
    expect(skuKind("constructor")).toBe("consumption");
    expect(skuKind("toString")).toBe("consumption");
    expect(skuKind("valueOf")).toBe("consumption");
    expect(skuKind("hasOwnProperty")).toBe("consumption");
  });
});
