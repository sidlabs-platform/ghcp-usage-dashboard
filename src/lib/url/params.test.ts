import { describe, it, expect } from "vitest";
import {
  parseDateRangeFromURL,
  serializeDateRangeToURL,
  parseScopeFromURL,
  serializeScopeToURL,
  applyParamsToURL,
} from "./params";
import { DEFAULT_DATE_RANGE_DAYS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sp(record: Record<string, string>): URLSearchParams {
  return new URLSearchParams(record);
}

// ---------------------------------------------------------------------------
// parseDateRangeFromURL
// ---------------------------------------------------------------------------

describe("parseDateRangeFromURL", () => {
  it("returns null when no relevant params", () => {
    expect(parseDateRangeFromURL(sp({}))).toBeNull();
    expect(parseDateRangeFromURL(sp({ foo: "bar" }))).toBeNull();
  });

  it("parses a preset range", () => {
    const result = parseDateRangeFromURL(sp({ range: "28d" }));
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("preset");
    expect(result!.days).toBe(28);
  });

  it("parses a 7-day (default) preset", () => {
    const result = parseDateRangeFromURL(sp({ range: "7d" }));
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("preset");
    expect(result!.days).toBe(DEFAULT_DATE_RANGE_DAYS);
  });

  it("parses a month range", () => {
    const result = parseDateRangeFromURL(sp({ range: "2026-08" }));
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("month");
    expect(result!.month).toBe("2026-08");
  });

  it("parses a custom range", () => {
    const result = parseDateRangeFromURL(sp({ from: "2026-08-01", to: "2026-08-15" }));
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("custom");
    expect(result!.customStart).toBe("2026-08-01");
    expect(result!.customEnd).toBe("2026-08-15");
  });

  it("rejects custom range where start > end", () => {
    expect(parseDateRangeFromURL(sp({ from: "2026-08-15", to: "2026-08-01" }))).toBeNull();
  });

  it("rejects malformed preset (letters)", () => {
    expect(parseDateRangeFromURL(sp({ range: "abc" }))).toBeNull();
  });

  it("rejects invalid month (month 13)", () => {
    expect(parseDateRangeFromURL(sp({ range: "2026-13" }))).toBeNull();
  });

  it("rejects out-of-range preset (>365d)", () => {
    expect(parseDateRangeFromURL(sp({ range: "999d" }))).toBeNull();
  });

  it("rejects custom range with invalid date format", () => {
    expect(parseDateRangeFromURL(sp({ from: "not-a-date", to: "2026-08-15" }))).toBeNull();
  });

  it("rejects a deep-linked day that does not exist rather than rolling it forward", () => {
    // Date.parse would turn these into March 1 and May 1 respectively, seeding
    // state with a window the API then rejects.
    expect(parseDateRangeFromURL(sp({ from: "2026-02-29", to: "2026-03-05" }))).toBeNull();
    expect(parseDateRangeFromURL(sp({ from: "2026-04-01", to: "2026-04-31" }))).toBeNull();
    expect(parseDateRangeFromURL(sp({ from: "2026-03-00", to: "2026-03-05" }))).toBeNull();
  });

  it("still accepts a real leap day", () => {
    const result = parseDateRangeFromURL(sp({ from: "2024-02-29", to: "2024-03-05" }));
    expect(result).not.toBeNull();
    expect(result!.customStart).toBe("2024-02-29");
  });

  it("custom takes precedence over range when both present", () => {
    const result = parseDateRangeFromURL(sp({ from: "2026-08-01", to: "2026-08-15", range: "28d" }));
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// serializeDateRangeToURL
// ---------------------------------------------------------------------------

describe("serializeDateRangeToURL", () => {
  it("serializes preset to ?range=Nd", () => {
    const updates = serializeDateRangeToURL("preset", 28, "", "", "2026-08");
    expect(updates.range).toBe("28d");
    expect(updates.from).toBeNull();
    expect(updates.to).toBeNull();
  });

  it("omits range param when preset is at default", () => {
    const updates = serializeDateRangeToURL("preset", DEFAULT_DATE_RANGE_DAYS, "", "", "");
    expect(updates.range).toBeNull();
  });

  it("serializes month to ?range=YYYY-MM", () => {
    const updates = serializeDateRangeToURL("month", 7, "", "", "2026-08");
    expect(updates.range).toBe("2026-08");
    expect(updates.from).toBeNull();
    expect(updates.to).toBeNull();
  });

  it("serializes custom to ?from=...&to=...", () => {
    const updates = serializeDateRangeToURL("custom", 14, "2026-08-01", "2026-08-14", "");
    expect(updates.range).toBeNull();
    expect(updates.from).toBe("2026-08-01");
    expect(updates.to).toBe("2026-08-14");
  });

  // Round-trip: parse then serialize
  it("round-trips preset mode", () => {
    const parsed = parseDateRangeFromURL(sp({ range: "90d" }))!;
    const serialized = serializeDateRangeToURL(parsed.mode, parsed.days, parsed.customStart, parsed.customEnd, parsed.month);
    expect(new URLSearchParams(Object.fromEntries(Object.entries(serialized).filter(([, v]) => v !== null) as [string, string][])).get("range")).toBe("90d");
  });

  it("round-trips month mode", () => {
    const parsed = parseDateRangeFromURL(sp({ range: "2026-08" }))!;
    const serialized = serializeDateRangeToURL(parsed.mode, parsed.days, parsed.customStart, parsed.customEnd, parsed.month);
    expect(serialized.range).toBe("2026-08");
  });

  it("round-trips custom mode", () => {
    const parsed = parseDateRangeFromURL(sp({ from: "2026-08-01", to: "2026-08-15" }))!;
    const serialized = serializeDateRangeToURL(parsed.mode, parsed.days, parsed.customStart, parsed.customEnd, parsed.month);
    expect(serialized.from).toBe("2026-08-01");
    expect(serialized.to).toBe("2026-08-15");
    expect(serialized.range).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseScopeFromURL / serializeScopeToURL
// ---------------------------------------------------------------------------

describe("parseScopeFromURL", () => {
  it("returns empty arrays when no params", () => {
    const result = parseScopeFromURL(sp({}));
    expect(result.enterprises).toEqual([]);
    expect(result.entTeams).toEqual([]);
    expect(result.orgTeams).toEqual([]);
    expect(result.orgs).toEqual([]);
  });

  it("parses enterprises", () => {
    const result = parseScopeFromURL(sp({ enterprises: "foo,bar" }));
    expect(result.enterprises).toEqual(["foo", "bar"]);
  });

  it("parses entteams and orgteams separately", () => {
    const result = parseScopeFromURL(sp({ entteams: "ent:teamA", orgteams: "org:teamB" }));
    expect(result.entTeams).toEqual(["ent:teamA"]);
    expect(result.orgTeams).toEqual(["org:teamB"]);
  });

  it("parses orgs", () => {
    const result = parseScopeFromURL(sp({ orgs: "org1,org2" }));
    expect(result.orgs).toEqual(["org1", "org2"]);
  });

  it("ignores empty values in comma-separated list", () => {
    const result = parseScopeFromURL(sp({ enterprises: "foo,,bar," }));
    expect(result.enterprises).toEqual(["foo", "bar"]);
  });
});

describe("serializeScopeToURL", () => {
  it("serializes non-empty arrays", () => {
    const updates = serializeScopeToURL(["foo"], ["ent:a"], ["org:b"], ["org1"]);
    expect(updates.enterprises).toBe("foo");
    expect(updates.entteams).toBe("ent:a");
    expect(updates.orgteams).toBe("org:b");
    expect(updates.orgs).toBe("org1");
  });

  it("sets null for empty arrays (to clear URL param)", () => {
    const updates = serializeScopeToURL([], [], [], []);
    expect(updates.enterprises).toBeNull();
    expect(updates.entteams).toBeNull();
    expect(updates.orgteams).toBeNull();
    expect(updates.orgs).toBeNull();
  });

  it("round-trips scope", () => {
    const original = { enterprises: ["foo", "bar"], entTeams: ["ent:a"], orgTeams: ["org:b"], orgs: ["org1"] };
    const serialized = serializeScopeToURL(original.enterprises, original.entTeams, original.orgTeams, original.orgs);
    const params = new URLSearchParams(Object.fromEntries(Object.entries(serialized).filter(([, v]) => v !== null) as [string, string][]));
    const parsed = parseScopeFromURL(params);
    expect(parsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// applyParamsToURL
// ---------------------------------------------------------------------------

describe("applyParamsToURL", () => {
  it("preserves existing unrelated params", () => {
    const existing = new URLSearchParams({ unrelated: "keep-me", range: "7d" });
    const result = applyParamsToURL(existing, { range: "28d" });
    expect(result.get("unrelated")).toBe("keep-me");
    expect(result.get("range")).toBe("28d");
  });

  it("deletes params with null value", () => {
    const existing = new URLSearchParams({ range: "7d", from: "2026-01-01" });
    const result = applyParamsToURL(existing, { range: null });
    expect(result.has("range")).toBe(false);
    expect(result.get("from")).toBe("2026-01-01");
  });

  it("does not mutate original URLSearchParams", () => {
    const existing = new URLSearchParams({ range: "7d" });
    applyParamsToURL(existing, { range: "28d" });
    expect(existing.get("range")).toBe("7d");
  });
});
