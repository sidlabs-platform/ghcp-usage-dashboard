import { describe, expect, it } from "vitest";
import {
  deriveMetricState,
  type MetricThresholds,
} from "@/components/cards/MetricCard";

describe("deriveMetricState", () => {
  it("treats values outside a higher-is-better bad-only threshold as neutral", () => {
    const thresholds: MetricThresholds = { bad: 40, higherIsBetter: true };

    expect(deriveMetricState(39, thresholds)).toBe("bad");
    expect(deriveMetricState(40, thresholds)).toBe("neutral");
    expect(deriveMetricState(80, thresholds)).toBe("neutral");
  });

  it("treats values outside a lower-is-better bad-only threshold as neutral", () => {
    const thresholds: MetricThresholds = { bad: 15, higherIsBetter: false };

    expect(deriveMetricState(16, thresholds)).toBe("bad");
    expect(deriveMetricState(15, thresholds)).toBe("neutral");
    expect(deriveMetricState(3, thresholds)).toBe("neutral");
  });

  it("supports good-only thresholds without inventing a watch state", () => {
    const thresholds: MetricThresholds = { good: 70, higherIsBetter: true };

    expect(deriveMetricState(70, thresholds)).toBe("good");
    expect(deriveMetricState(69, thresholds)).toBe("neutral");
  });
});
