import { describe, it, expect } from "vitest";
import { getQueryClient } from "./query-client";

describe("query-client", () => {
  it("returns same QueryClient instance on repeated calls", () => {
    const first = getQueryClient();
    const second = getQueryClient();
    expect(first).toBe(second);
  });
});
