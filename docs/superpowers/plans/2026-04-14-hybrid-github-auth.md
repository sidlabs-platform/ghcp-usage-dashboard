# Hybrid GitHub Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PAT, GitHub App, and hybrid authentication so the dashboard can use installation tokens where GitHub supports them and fall back to PATs for enterprise-only endpoints.

**Architecture:** Introduce a single shared auth provider in `src/lib/github/auth.ts` that resolves the active auth mode and returns headers for a named GitHub API capability. Keep the existing sync and page flows intact by changing the shared fetch helpers in `src/lib/github/api-base.ts` and `src/lib/github/billing-client.ts` instead of scattering auth logic across each caller.

**Tech Stack:** Next.js 15, TypeScript, Node.js 20 `crypto`, GitHub REST APIs, lightweight TS test execution via `tsx` + Node test runner if needed for auth unit coverage.

---

## File map

- **Create:** `src/lib/github/auth.ts` — auth mode parsing, GitHub App JWT creation, installation token caching, capability matrix, hybrid fallback logic
- **Create:** `src/lib/github/auth.test.ts` — focused unit coverage for mode resolution and capability fallback behavior
- **Modify:** `package.json` — add a minimal test script if needed for the new auth tests
- **Modify:** `src/lib/github/api-base.ts` — route all authenticated GitHub fetches through the shared auth provider
- **Modify:** `src/lib/github/billing-client.ts` — remove direct `process.env.GITHUB_TOKEN` usage and use capability-aware auth
- **Modify:** `src/lib/github/metrics-client.ts` — mark enterprise vs org Copilot endpoints with the correct auth capability
- **Modify:** `src/lib/github/seats-client.ts` — mark enterprise vs org seat endpoints with the correct auth capability
- **Modify:** `src/lib/github/teams-client.ts` — mark enterprise vs org teams endpoints with the correct auth capability
- **Modify:** `src/lib/github/code-scanning-client.ts` — mark org security endpoints for App/hybrid usage
- **Modify:** `src/lib/github/dependabot-client.ts` — mark org security endpoints for App/hybrid usage
- **Modify:** `src/lib/github/secret-scanning-client.ts` — mark org security endpoints for App/hybrid usage
- **Modify:** `.env.local.example` — document the new auth env vars
- **Modify:** `README.md` — explain PAT, App, and hybrid setup and the enterprise fallback caveat

## Root cause

The current implementation is hard-wired to `process.env.GITHUB_TOKEN` in `src/lib/github/api-base.ts` and `src/lib/github/billing-client.ts`. Because every GitHub API call depends on that single env var, the app has no way to choose GitHub App tokens for supported endpoints or PAT fallback for unsupported enterprise endpoints.

## Capability matrix to encode in code

Use this matrix in `src/lib/github/auth.ts`:

| Capability | Hybrid/App token allowed? | Fallback |
| --- | --- | --- |
| Org Copilot metrics | Yes | PAT if App token fetch fails in hybrid |
| Enterprise Copilot metrics | No | PAT required |
| Org Copilot seats | Yes | PAT if App token fetch fails in hybrid |
| Enterprise Copilot seats | No | PAT required |
| Org teams | Yes | PAT if App token fetch fails in hybrid |
| Enterprise teams | No | PAT required |
| Org security (code scanning / dependabot / secret scanning) | Yes | PAT if App token fetch fails in hybrid |
| Enterprise security endpoints | Treat as PAT-only initially | PAT required |
| Billing usage report exports | Yes | PAT if App token fetch fails in hybrid |

### Task 1: Add the failing auth behavior tests

**Files:**
- Modify: `package.json`
- Create: `src/lib/github/auth.test.ts`

- [ ] **Step 1: Add a minimal test entry so the repo can run a focused auth test**

```json
{
  "scripts": {
    "test": "node --import tsx --test"
  },
  "devDependencies": {
    "tsx": "^4.19.2"
  }
}
```

- [ ] **Step 2: Write the failing test first**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseAuthStrategy,
  getAuthMode,
  type GitHubCapability,
} from "./auth";

test("defaults to pat mode when no explicit auth mode is set", () => {
  const env = {};
  assert.equal(getAuthMode(env), "pat");
});

test("hybrid mode uses app auth for org metrics", () => {
  const capability: GitHubCapability = "orgCopilotMetrics";
  assert.equal(chooseAuthStrategy("hybrid", capability), "app");
});

test("hybrid mode falls back to pat for enterprise metrics", () => {
  const capability: GitHubCapability = "enterpriseCopilotMetrics";
  assert.equal(chooseAuthStrategy("hybrid", capability), "pat");
});

test("app-only mode rejects unsupported enterprise capabilities", () => {
  assert.throws(
    () => chooseAuthStrategy("app", "enterpriseTeams"),
    /does not support GitHub App authentication/,
  );
});
```

- [ ] **Step 3: Run the test and verify it fails for the expected reason**

Run: `npm test -- src/lib/github/auth.test.ts`

Expected: **FAIL** because `src/lib/github/auth.ts` and its exports do not exist yet.

- [ ] **Step 4: Commit the red test scaffold**

```bash
git add package.json package-lock.json src/lib/github/auth.test.ts
git commit -m "test: add auth mode regression coverage"
```

### Task 2: Implement the shared auth provider

**Files:**
- Create: `src/lib/github/auth.ts`
- Test: `src/lib/github/auth.test.ts`

- [ ] **Step 1: Implement the smallest possible auth provider to satisfy the failing tests**

```ts
import crypto from "crypto";

export type AuthMode = "pat" | "app" | "hybrid";
export type AuthStrategy = "pat" | "app";
export type GitHubCapability =
  | "orgCopilotMetrics"
  | "enterpriseCopilotMetrics"
  | "orgCopilotSeats"
  | "enterpriseCopilotSeats"
  | "orgTeams"
  | "enterpriseTeams"
  | "orgSecurity"
  | "enterpriseSecurity"
  | "billingReports";

const APP_COMPATIBILITY: Record<GitHubCapability, boolean> = {
  orgCopilotMetrics: true,
  enterpriseCopilotMetrics: false,
  orgCopilotSeats: true,
  enterpriseCopilotSeats: false,
  orgTeams: true,
  enterpriseTeams: false,
  orgSecurity: true,
  enterpriseSecurity: false,
  billingReports: true,
};

export function getAuthMode(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AuthMode {
  const mode = env.GITHUB_AUTH_MODE?.trim().toLowerCase();
  if (mode === "app" || mode === "hybrid" || mode === "pat") return mode;
  return "pat";
}

export function chooseAuthStrategy(mode: AuthMode, capability: GitHubCapability): AuthStrategy {
  const appAllowed = APP_COMPATIBILITY[capability];
  if (mode === "pat") return "pat";
  if (mode === "app") {
    if (!appAllowed) {
      throw new Error(`${capability} does not support GitHub App authentication. Use PAT or hybrid mode.`);
    }
    return "app";
  }
  return appAllowed ? "app" : "pat";
}

let cachedInstallationToken: { token: string; expiresAt: number } | null = null;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${header}.${payload}.${base64Url(signature)}`;
}

export async function getAuthToken(capability: GitHubCapability): Promise<string> {
  const mode = getAuthMode();
  const strategy = chooseAuthStrategy(mode, capability);
  if (strategy === "pat") {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is required for PAT-backed GitHub API calls.");
    return token;
  }

  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !installationId || !privateKey) {
    if (mode === "hybrid" && process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    throw new Error("GitHub App auth requires GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY.");
  }

  if (cachedInstallationToken && cachedInstallationToken.expiresAt > Date.now() + 60_000) {
    return cachedInstallationToken.token;
  }

  const jwt = createAppJwt(appId, privateKey);
  const resp = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    if (mode === "hybrid" && process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    throw new Error(`Failed to create GitHub App installation token: ${resp.status} ${body}`);
  }

  const data = await resp.json() as { token: string; expires_at: string };
  cachedInstallationToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  return data.token;
}

export async function getAuthHeaders(capability: GitHubCapability): Promise<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${await getAuthToken(capability)}`,
    "X-GitHub-Api-Version": "2026-03-10",
  };
}
```

- [ ] **Step 2: Re-run the focused auth tests**

Run: `npm test -- src/lib/github/auth.test.ts`

Expected: **PASS** for the new mode-resolution and fallback tests.

- [ ] **Step 3: Keep the provider small and focused**

Do **not** add UI, database fields, or config-file secrets here. Keep auth source-of-truth in environment variables only.

- [ ] **Step 4: Commit the provider**

```bash
git add src/lib/github/auth.ts src/lib/github/auth.test.ts package.json package-lock.json
git commit -m "feat: add shared github auth provider"
```

### Task 3: Route all GitHub clients through the auth capability layer

**Files:**
- Modify: `src/lib/github/api-base.ts`
- Modify: `src/lib/github/billing-client.ts`
- Modify: `src/lib/github/metrics-client.ts`
- Modify: `src/lib/github/seats-client.ts`
- Modify: `src/lib/github/teams-client.ts`
- Modify: `src/lib/github/code-scanning-client.ts`
- Modify: `src/lib/github/dependabot-client.ts`
- Modify: `src/lib/github/secret-scanning-client.ts`
- Test: `src/lib/github/auth.test.ts`

- [ ] **Step 1: Expand the tests with one more failing assertion for a real fetch path**

```ts
test("hybrid uses pat for enterprise seat sync", () => {
  assert.equal(chooseAuthStrategy("hybrid", "enterpriseCopilotSeats"), "pat");
});
```

- [ ] **Step 2: Change `api-base.ts` to accept a capability argument**

```ts
import { getAuthHeaders, type GitHubCapability } from "./auth";

export async function githubFetch<T>(
  path: string,
  retries = 3,
  capability: GitHubCapability = "enterpriseCopilotMetrics",
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    await adaptiveRateDelay();
    const resp = await fetch(url, {
      headers: await getAuthHeaders(capability),
      cache: "no-store",
    });
    // existing retry logic stays unchanged
  }

  throw new Error(`GitHub API failed after ${retries} retries on ${path}`);
}

export async function githubFetchPaginated<T>(
  path: string,
  perPage = 100,
  capability: GitHubCapability = "enterpriseCopilotMetrics",
): Promise<T[]> {
  // keep the existing pagination loop, but fetch each page with:
  // headers: await getAuthHeaders(capability)
}

export async function githubFetchPaginatedWithCutoff<T extends { updated_at: string }>(
  path: string,
  cutoffDate: string | null = null,
  perPage = 100,
  capability: GitHubCapability = "enterpriseSecurity",
): Promise<T[]> {
  // keep the existing cutoff loop, but fetch each page with:
  // headers: await getAuthHeaders(capability)
}
```

- [ ] **Step 3: Mark the client calls with the correct capability**

```ts
// metrics-client.ts
await githubFetch<ReportResponse>(
  `/enterprises/${enterprise}/copilot/metrics/reports/enterprise-1-day?day=${day}`,
  3,
  "enterpriseCopilotMetrics",
);

await githubFetch<ReportResponse>(
  `/orgs/${org}/copilot/metrics/reports/organization-1-day?day=${day}`,
  3,
  "orgCopilotMetrics",
);

// seats-client.ts
await githubFetch<CopilotSeatsResponse>(
  `/enterprises/${enterprise}/copilot/billing/seats?per_page=100`,
  3,
  "enterpriseCopilotSeats",
);

// teams-client.ts
return githubFetchPaginated<GitHubTeam>(`/orgs/${org}/teams`, 100, "orgTeams");

// code-scanning-client.ts
return githubFetchPaginatedWithCutoff<CodeScanningAlert>(
  `/orgs/${org}/code-scanning/alerts?sort=updated&direction=desc`,
  cutoffDate ?? null,
  100,
  "orgSecurity",
);
```

- [ ] **Step 4: Remove the direct token read from `billing-client.ts`**

```ts
import { getAuthHeaders } from "./auth";

const resp = await fetch(url, {
  method: "POST",
  headers: {
    ...(await getAuthHeaders("billingReports")),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    report_type: reportType,
    start_date: startDate,
    end_date: endDate,
    send_email: false,
  }),
  cache: "no-store",
});
```

- [ ] **Step 5: Verify type-safety and regression safety**

Run: `npm test -- src/lib/github/auth.test.ts && npx tsc --noEmit`

Expected: **PASS** for the auth tests and **0 TypeScript errors**.

- [ ] **Step 6: Commit the wiring change**

```bash
git add src/lib/github/api-base.ts src/lib/github/billing-client.ts src/lib/github/metrics-client.ts src/lib/github/seats-client.ts src/lib/github/teams-client.ts src/lib/github/code-scanning-client.ts src/lib/github/dependabot-client.ts src/lib/github/secret-scanning-client.ts
git commit -m "refactor: route github clients through capability auth"
```

### Task 4: Document configuration and unsupported-endpoint behavior

**Files:**
- Modify: `.env.local.example`
- Modify: `README.md`

- [ ] **Step 1: Add the new environment variable examples**

```env
# Auth mode: pat | app | hybrid
GITHUB_AUTH_MODE=hybrid

# PAT: required for pat mode, and still required in hybrid mode for enterprise-only endpoints
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# GitHub App: required for app or hybrid mode
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

- [ ] **Step 2: Update the README auth section with the exact behavior**

```md
### Authentication Modes

- `pat` — current behavior; all GitHub calls use `GITHUB_TOKEN`
- `app` — supported org-level and billing-report endpoints use the GitHub App installation token; unsupported enterprise endpoints return a clear configuration error
- `hybrid` — prefer GitHub App installation tokens where supported and automatically fall back to `GITHUB_TOKEN` for enterprise-only endpoints

> Note: enterprise Copilot metrics, enterprise teams, and enterprise-wide seat assignment endpoints still require PAT fallback.
```

- [ ] **Step 3: Build the app to confirm the docs/config change did not break anything**

Run: `npm run build`

Expected: Next.js production build completes successfully.

- [ ] **Step 4: Commit the docs update**

```bash
git add .env.local.example README.md
git commit -m "docs: add github app and hybrid auth setup"
```

### Task 5: Smoke-test the three supported modes locally

**Files:**
- No committed source change required

- [ ] **Step 1: Verify backward compatibility in PAT mode**

Run with:

```powershell
$env:GITHUB_AUTH_MODE="pat"
npm run build
```

Expected: existing PAT-only setup still works with no code-path changes for current users.

- [ ] **Step 2: Verify hybrid mode behavior**

Run with App env vars plus `GITHUB_TOKEN` and trigger a sync from the UI.

Expected:
- org-level Copilot/security/team calls authenticate successfully with the App token
- enterprise-only endpoints still succeed through PAT fallback

- [ ] **Step 3: Verify the failure mode in App-only setup**

Run with:

```powershell
$env:GITHUB_AUTH_MODE="app"
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
```

Expected: unsupported enterprise endpoints fail with a clear message telling the operator to switch to `hybrid` or provide a PAT.

---

## Notes and guardrails

- Keep secrets in env vars only; do **not** store the private key in `dashboard-config.json`.
- Preserve the current default behavior by making `pat` the implicit mode when `GITHUB_AUTH_MODE` is missing.
- Do not change the database schema; this feature belongs in the GitHub API/auth layer only.
- If later GitHub expands App-token support for more enterprise endpoints, update only the capability matrix in `src/lib/github/auth.ts`.
