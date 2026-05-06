import { describe, it, expect, vi } from "vitest";

vi.mock("./api-base", () => ({
  githubFetch: vi.fn(),
  githubFetchPaginatedWithCutoff: vi.fn(() => []),
  githubFetchCursorPaginatedWithCutoff: vi.fn(() => []),
  GitHubApiError: class extends Error { status: number; constructor(s: number) { super(); this.status = s; } },
}));

import { codeScanningClient } from "./code-scanning-client";
import { dependabotClient } from "./dependabot-client";
import { secretScanningClient } from "./secret-scanning-client";
import { githubFetch, githubFetchPaginatedWithCutoff, githubFetchCursorPaginatedWithCutoff, GitHubApiError } from "./api-base";

const mockPaginatedCutoff = githubFetchPaginatedWithCutoff as ReturnType<typeof vi.fn>;
const mockCursorCutoff = githubFetchCursorPaginatedWithCutoff as ReturnType<typeof vi.fn>;
const mockGithubFetch = githubFetch as ReturnType<typeof vi.fn>;

describe("CodeScanningClient", () => {
  it("getOrgAlerts calls paginated with cutoff", async () => {
    mockPaginatedCutoff.mockResolvedValue([{ number: 1 }]);
    const result = await codeScanningClient.getOrgAlerts("my-org", "2024-01-01");
    expect(result).toHaveLength(1);
  });

  it("getEnterpriseAlerts calls paginated with cutoff", async () => {
    mockPaginatedCutoff.mockResolvedValue([{ number: 2 }]);
    const result = await codeScanningClient.getEnterpriseAlerts("ent");
    expect(result).toHaveLength(1);
  });

  it("getAlertAutofixStatus returns data on success", async () => {
    mockGithubFetch.mockResolvedValue({ status: "success" });
    const result = await codeScanningClient.getAlertAutofixStatus("owner", "repo", 1);
    expect(result?.status).toBe("success");
  });

  it("getAlertAutofixStatus returns null on 404", async () => {
    const err = new (GitHubApiError as any)(404);
    err.status = 404;
    mockGithubFetch.mockRejectedValue(err);
    const result = await codeScanningClient.getAlertAutofixStatus("owner", "repo", 99);
    expect(result).toBeNull();
  });
});

describe("DependabotClient", () => {
  it("getOrgAlerts calls cursor-paginated with cutoff", async () => {
    mockCursorCutoff.mockResolvedValue([{ number: 1 }]);
    const result = await dependabotClient.getOrgAlerts("my-org", "2024-01-01");
    expect(result).toHaveLength(1);
  });

  it("getEnterpriseAlerts calls cursor-paginated", async () => {
    mockCursorCutoff.mockResolvedValue([]);
    const result = await dependabotClient.getEnterpriseAlerts("ent");
    expect(result).toEqual([]);
  });
});

describe("SecretScanningClient", () => {
  it("getOrgAlerts calls paginated with cutoff", async () => {
    mockPaginatedCutoff.mockResolvedValue([{ number: 1 }]);
    const result = await secretScanningClient.getOrgAlerts("my-org");
    expect(result).toHaveLength(1);
  });

  it("getEnterpriseAlerts calls paginated with cutoff", async () => {
    mockPaginatedCutoff.mockResolvedValue([{ number: 5 }]);
    const result = await secretScanningClient.getEnterpriseAlerts("ent", "2024-06-01");
    expect(result).toHaveLength(1);
  });
});
