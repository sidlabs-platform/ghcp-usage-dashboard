import { describe, it, expect, afterEach, vi } from "vitest";
import { getDiscoveredOrgsFromDb, _resetLoader } from "./orgs-resolver";

vi.mock("../db/orgs-repo", () => ({
  getEnterpriseOrgs: vi.fn((slug: string) => [`mocked-${slug}`]),
}));

describe("getDiscoveredOrgsFromDb", () => {
  afterEach(() => _resetLoader());

  it("returns orgs from the loader when available", () => {
    _resetLoader(() => ["org-a", "org-b"]);
    expect(getDiscoveredOrgsFromDb("my-ent")).toEqual(["org-a", "org-b"]);
  });

  it("passes enterprise slug to the loader", () => {
    const calls: string[] = [];
    _resetLoader((slug) => {
      calls.push(slug);
      return ["org-x"];
    });
    getDiscoveredOrgsFromDb("ent-1");
    getDiscoveredOrgsFromDb("ent-2");
    expect(calls).toEqual(["ent-1", "ent-2"]);
  });

  it("returns empty array when loader throws", () => {
    _resetLoader(() => {
      throw new Error("DB not initialized");
    });
    expect(getDiscoveredOrgsFromDb("my-ent")).toEqual([]);
  });

  it("retries loading after a failure", () => {
    _resetLoader(() => {
      throw new Error("DB not ready");
    });
    expect(getDiscoveredOrgsFromDb("my-ent")).toEqual([]);

    // After failure, loader is reset — inject a working one
    _resetLoader(() => ["recovered-org"]);
    expect(getDiscoveredOrgsFromDb("my-ent")).toEqual(["recovered-org"]);
  });

  it("dynamically requires ../db/orgs-repo if loader is not overridden", () => {
    _resetLoader(undefined);
    expect(getDiscoveredOrgsFromDb("test-ent")).toEqual(["mocked-test-ent"]);
  });
});
