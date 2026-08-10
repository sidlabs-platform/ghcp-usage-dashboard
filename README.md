# GitHub Copilot Enterprise Usage Metrics Dashboard

A comprehensive dashboard for visualizing GitHub Copilot usage metrics, GHAS security posture, and billing data across your enterprise, organizations, teams, and individual users.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Configuration File (`dashboard-config.json`)](#configuration-file-dashboard-configjson)
- [Example Configurations](#example-configurations)
- [Dashboard Pages](#dashboard-pages)
- [Page Visibility Reference](#page-visibility-reference)
- [Data Sync](#data-sync)
- [Historical License Reconciliation](#historical-license-reconciliation)
- [Filtering & Scope](#filtering--scope)
- [Exporting Data](#exporting-data)
- [Architecture](#architecture)
- [Production Deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

### Dashboard Pages

| Page | Description |
|------|-------------|
| **📊 Overview** | KPI cards, active user trends, acceptance rates, chat mode distribution |
| **🛡️ Security (GHAS)** | Code scanning, Dependabot, and secret scanning alert dashboards |
| **💻 Code Generation** | Lines of code metrics, user vs agent code changes, language/model breakdowns |
| **✨ Copilot Features** | Ask/Edit/Plan/Agent/Custom mode tracking, model usage, adoption trends |
| **🧠 Model Statistics** | AI model usage distribution and trends across all Copilot features |
| **⌨️ CLI Analytics** | Copilot CLI sessions, requests, token consumption, version distribution |
| **🔀 Pull Requests** | PR lifecycle metrics, Copilot vs human comparison, merge time analysis |
| **👥 Team Analytics** | Computed team-level metrics, leaderboard, adoption heatmap |
| **👤 User Explorer** | Individual user drill-down, feature adoption per user |
| **💳 Seat Management** | License utilization, idle seat detection, team assignment distribution |
| **🖥️ IDE & Languages** | IDE distribution, language heatmap, version tracking |
| **💰 Billing** | Cost overview, product/org/user breakdowns, cost trends |
| **📈 Metered Usage** | Detailed metered usage reports by product, org, and user |
| **⚡ AI Credits** | AI credit consumption, model breakdown, user-level analysis |
| **📜 License & AI Credits** | Per-user license lifecycle + AI-credit reconciliation. Live snapshot by default; period-aware historical detail/rollup, data-quality checks, and run history when historical licensing sync is enabled — see [Historical License Reconciliation](#historical-license-reconciliation) |
| **👤 AI Credits by User** | Sortable user-level AI credit consumption table |

### Additional Capabilities

- **🌙 Dark / Light Mode** — full theme support, toggled from the header
- **📥 Export** — CSV for table pages, PDF screenshots for chart pages
- **🔍 Scope Filtering** — filter all pages by enterprise team, org team, or organization
- **📅 Date Range Presets** — 7, 14, 28, 90, 180, or 365 day windows

---

## Prerequisites

- **Node.js 20–22** (with npm). The repo pins Node 20 via `.nvmrc` and enforces `>=20 <23` through `package.json` `engines`, matching CI. Node 23+ is not supported because the `better-sqlite3` native addon does not build against its V8 API. With `nvm`, `fnm`, or Volta installed, run `nvm use` / `fnm use` in the repo root to pick up the right version.
- A **GitHub Personal Access Token** (classic or fine-grained) with scopes appropriate for the features you enable:

| Feature | Classic PAT Scope | Fine-Grained PAT Permission |
|---------|-------------------|----------------------------|
| Copilot enterprise metrics | `manage_billing:copilot` or `read:enterprise` | — |
| Organization metrics | `read:org` | Organization: Read |
| Enterprise teams | `read:enterprise` | — |
| GHAS (Security) | `security_events` | `code_scanning_alerts:read`, `dependabot_alerts:read`, `secret_scanning_alerts:read` |
| Billing | — | Enterprise: `Enterprise administration` (write) |
| Historical license reconciliation — **required** | `manage_billing:copilot`/`read:enterprise` (seats) | same as Copilot enterprise metrics |
| Historical license reconciliation — optional (audit) | `read:audit_log` or `admin:enterprise` | Fine-grained tokens are probed per-endpoint (see below) |
| Historical license reconciliation — optional (membership/identity) | `read:enterprise`/`admin:enterprise` | Fine-grained tokens are probed per-endpoint |

> **Tip:** If you only need Copilot metrics (no GHAS or billing), a classic PAT with `manage_billing:copilot` + `read:org` is sufficient.

### Capability preflight (classic vs. fine-grained PATs)

Historical license reconciliation calls `GET /api/billing/license-reconciliation/preflight?enterprise=<slug>` before/independent of a sync to report per-capability access, without ever exposing the token itself:

- **Classic PATs** return their granted scopes via the `X-OAuth-Scopes` response header on `/rate_limit` — the preflight maps those scopes directly to `supported`/`unsupported` per capability, with no extra API calls.
- **Fine-grained PATs and GitHub App installation tokens** never send that header, so the preflight instead probes one minimal read-only endpoint per capability and classifies support from the resulting status code (`200` → supported, non-rate-limited `403`/`404` → unsupported, a rate-limited/transport failure → `unknown`, never guessed as unsupported).
- Only `copilot_seats` is **required**; `billing_usage`, `aic_consumption`, `audit_log`, `membership`, and `identity` are optional — an unsupported optional capability degrades the corresponding source to a warning, never a hard failure. A 401/403 on the initial identity check (`/rate_limit`) means the credential itself is invalid, and every capability is reported `unsupported` with a generic, sanitized message.

---

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd ghcp-usage-dashboard

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.local.example .env.local

# 4. Edit .env.local — set at minimum:
#    GITHUB_TOKEN=ghp_xxxxxxxxxxxx
#    GITHUB_ENTERPRISE=your-enterprise-slug

# 5. Start the development server
npm run dev
```

Then:

1. Open **http://localhost:3000** in your browser
2. Click the **Sync** button in the top-right header
3. Wait for the initial backfill to complete (~3–5 minutes for 90 days)
4. Explore the dashboard!

---

## Environment Variables

Set these in `.env.local` at the project root.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | **Yes**\*\* | — | GitHub Personal Access Token (see [Prerequisites](#prerequisites) for scopes). \*\*Optional when GitHub App auth is configured and enterprise mode is disabled. |
| `GITHUB_ENTERPRISE` | **Yes**\* | — | Your enterprise slug (as shown in `github.com/enterprises/<slug>`). \*Not required if you disable enterprise mode in `dashboard-config.json`. |
| `GITHUB_ORGS` | No | — | Comma-separated list of organization slugs to track. If empty, the dashboard discovers orgs from the enterprise. |
| `BACKFILL_DAYS` | No | `90` | Number of days to backfill on first sync (max: 365) |
| `GITHUB_API_BASE` | No | `https://api.github.com` | Base URL for the GitHub API. Set this for GHES installations (e.g., `https://github.example.com/api/v3`). |
| `GITHUB_APP_ID` | No | — | GitHub App ID (numeric). Required for GitHub App authentication. |
| `GITHUB_APP_PRIVATE_KEY` | No | — | GitHub App private key in PEM format. Use literal `\n` for newlines in env vars. |
| `GITHUB_APP_INSTALLATION_ID` | No | — | GitHub App installation ID (numeric). Found in your App's installation settings. |

### Example `.env.local`

```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_ENTERPRISE=my-company
GITHUB_ORGS=frontend-team,backend-team,platform
BACKFILL_DAYS=90

# Optional: GitHub App auth (see "GitHub App Authentication" below)
# GITHUB_APP_ID=123456
# GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
# GITHUB_APP_INSTALLATION_ID=78901234
```

> See `.env.local.example` for the full annotated template with all available variables.

### GitHub App Authentication

Instead of (or in addition to) a PAT, you can authenticate with a [GitHub App](https://docs.github.com/en/apps/creating-github-apps). This is recommended for org-level access because App tokens have their own rate limit pool (5,000 req/hr) separate from PAT limits, and provide better auditability.

**How it works:**

- When all 3 `GITHUB_APP_*` env vars are set, the dashboard uses the App's installation token for **org-level** and **repo-level** API calls (`/orgs/...`, `/repos/...`).
- **Enterprise-level** endpoints (`/enterprises/...`) always use the PAT — GitHub Apps cannot access enterprise admin APIs.
- When no App is configured, the PAT is used for everything (existing behavior).
- If enterprise mode is disabled and App auth is configured, `GITHUB_TOKEN` is optional.

**Setup:**

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app) with the following permissions:
   - **Organization permissions**: Copilot Metrics (read), Members (read)
   - **Repository permissions**: Code scanning alerts (read), Dependabot alerts (read), Secret scanning alerts (read)
2. Generate a private key and install the App on your organization(s).
3. Add the env vars:

```env
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_INSTALLATION_ID=78901234
```

> **Note:** In `.env.local`, use literal `\n` for newlines in the PEM key. The dashboard normalizes them automatically.

---

## Configuration File (`dashboard-config.json`)

The file `dashboard-config.json` in the project root controls which features are enabled, which organizations to include/exclude, and security sync settings. The dashboard reads this file at runtime (cached for 5 minutes). Changes take effect without a restart.

### Full Schema

```jsonc
{
  "metrics": {
    "copilot": {
      "enabled": true,          // Master toggle for all Copilot features
      "enterprise": true,       // Fetch enterprise-level aggregate data
      "userMetrics": true,      // Fetch per-user daily metrics
      "seats": true,            // Sync Copilot seat assignments
      "teams": true             // Sync team memberships for team analytics
    },
    "codeScanning": {
      "enabled": true           // Fetch GitHub code scanning alerts
    },
    "dependabot": {
      "enabled": true           // Fetch Dependabot alerts
    },
    "secretScanning": {
      "enabled": true           // Fetch secret scanning alerts
    },
    "billing": {
      "enabled": false,         // Master toggle for billing (requires enterprise)
      "meteredUsage": true,     // Sync metered usage reports
      "premiumRequests": true,  // Sync premium request reports
      "aiCredits": true,         // Sync AI credit reports (new billing model)
      "licensing": {            // Optional — historical license reconciliation (see below). Omit entirely for existing/default behavior.
        "creditToUsd": 0.01,
        "currency": "USD",
        "licenseCost": { "business": 19, "enterprise": 39 },
        "aicAllowance": { "business": 1900, "enterprise": 3900 },
        "history": { "enabled": false, "reportMonths": "last_1_months" },
        "identity": { "fetchMembership": false, "fetchEnterpriseIdentities": false, "fetchOrgIdentities": false },
        "aicConsumption": { "mode": "auto", "concurrency": 4 },
        "validation": { "enabled": true, "aicTolerancePct": 5 }
      }
    }
  },
  "organizations": {
    "include": [],              // If non-empty, ONLY these orgs are synced (subset of GITHUB_ORGS)
    "exclude": []               // These orgs are excluded from GITHUB_ORGS
  },
  "security": {
    "syncIntervalMinutes": 60,  // Minimum interval between GHAS syncs
    "backfillDays": 90          // How far back to fetch security alerts
  }
}
```

### Key Behaviors

- **`copilot.enterprise: false`** — Disables all enterprise-level API calls. Useful if you only have org-level access. Also force-disables billing (billing requires enterprise).
- **`copilot.userMetrics: false`** — Hides pages that depend on per-user data (Code Generation, Copilot Features, Models, CLI, Users, IDE & Languages, Team Analytics).
- **`copilot.seats: false`** — Hides the Seat Management page.
- **`copilot.teams: false`** — Hides the Team Analytics page.
- **`billing.enabled: true`** — Requires `copilot.enterprise: true` and a token with enterprise administration permissions.
- **`organizations.include`** / **`organizations.exclude`** — Fine-tune which of your `GITHUB_ORGS` are actually synced. Include takes precedence (if non-empty, only those orgs are synced).
- **Security toggles** — Each of `codeScanning`, `dependabot`, and `secretScanning` can be independently enabled/disabled. The Security page shows when at least one is enabled.
- **`billing.licensing`** — Entirely optional and additive; omitting it (or any of its sub-fields) preserves exact current behavior with documented defaults (see [Historical License Reconciliation](#historical-license-reconciliation)). `licensing.history.enabled: true` turns on historical (multi-period) reconciliation sync for every configured enterprise; it never invalidates or migrates existing `copilot_seats`/billing data.

---

## Example Configurations

### Full Enterprise (everything enabled)

```json
{
  "metrics": {
    "copilot": { "enabled": true, "enterprise": true, "userMetrics": true, "seats": true, "teams": true },
    "codeScanning": { "enabled": true },
    "dependabot": { "enabled": true },
    "secretScanning": { "enabled": true },
    "billing": { "enabled": true, "meteredUsage": true, "premiumRequests": true, "aiCredits": true }
  },
  "organizations": { "include": [], "exclude": [] },
  "security": { "syncIntervalMinutes": 60, "backfillDays": 90 }
}
```

### Organization-Only Mode (no enterprise slug)

Use this when you don't have enterprise-level access. Set `GITHUB_ENTERPRISE` to empty or omit it, and disable enterprise mode:

```json
{
  "metrics": {
    "copilot": { "enabled": true, "enterprise": false, "userMetrics": true, "seats": true, "teams": true },
    "codeScanning": { "enabled": false },
    "dependabot": { "enabled": false },
    "secretScanning": { "enabled": false },
    "billing": { "enabled": false }
  }
}
```

> **Note:** Billing is automatically disabled when enterprise mode is off.

### Copilot-Only (no GHAS, no billing)

```json
{
  "metrics": {
    "copilot": { "enabled": true, "enterprise": true, "userMetrics": true, "seats": true, "teams": true },
    "codeScanning": { "enabled": false },
    "dependabot": { "enabled": false },
    "secretScanning": { "enabled": false },
    "billing": { "enabled": false }
  }
}
```

### Security-Only (no Copilot metrics)

```json
{
  "metrics": {
    "copilot": { "enabled": false },
    "codeScanning": { "enabled": true },
    "dependabot": { "enabled": true },
    "secretScanning": { "enabled": true },
    "billing": { "enabled": false }
  },
  "security": { "syncIntervalMinutes": 30, "backfillDays": 180 }
}
```

---

## Dashboard Pages

### 📊 Overview

The landing page with KPI cards showing active users, acceptance rates, and high-level trends. Includes active user trends over time and chat mode distribution. Requires `copilot.enabled: true`.

### 🛡️ Security (GHAS)

Displays GitHub Advanced Security alert dashboards for code scanning, Dependabot, and secret scanning. Shows alert counts by severity, trends over time, and alert state breakdown. Requires at least one of `codeScanning`, `dependabot`, or `secretScanning` to be enabled. Needs `security_events` scope on the PAT.

### 💻 Code Generation

Lines of code suggested vs accepted, language breakdowns, model usage for completions, and user vs agent code change contributions. Requires `copilot.userMetrics: true`.

### ✨ Copilot Features (Chat Modes)

Tracks usage across Ask, Edit, Plan, Agent, and Custom modes. Shows adoption trends, model usage per mode, and feature comparison. Requires `copilot.userMetrics: true`. Supports both CSV and PDF export.

### 🧠 Model Statistics

AI model usage distribution and trends across all Copilot features. Shows which models are being used most and how usage is shifting over time. Requires `copilot.userMetrics: true`.

### ⌨️ CLI Analytics

Copilot CLI session counts, request volumes, token consumption, and CLI version distribution. Requires `copilot.userMetrics: true`. Supports both CSV and PDF export.

### 🔀 Pull Requests

PR lifecycle metrics comparing Copilot-assisted vs human-authored PRs. Includes merge time analysis and Copilot review impact. Requires `copilot.enabled: true`.

### 👥 Team Analytics

Team-level metrics computed by cross-referencing user daily metrics with team membership. Includes a leaderboard and adoption heatmap. Requires both `copilot.userMetrics: true` and `copilot.teams: true`.

> **Note:** The GitHub API does not provide native team-level metrics. This dashboard computes them by fetching user-level daily metrics via the `users-1-day` endpoint and cross-referencing with team membership from the Teams API.

### 👤 User Explorer

Individual user drill-down with feature adoption details and activity over time. Server-side paginated and searchable. Requires `copilot.userMetrics: true`. Supports CSV export.

### 💳 Seat Management

License utilization overview, idle seat detection, and team assignment distribution. Server-side paginated and searchable. Requires `copilot.seats: true`. Supports CSV export.

### 🖥️ IDE & Languages

IDE distribution (VS Code, JetBrains, Xcode, Neovim, Visual Studio, etc.), language usage heatmap, and editor version tracking. Requires `copilot.userMetrics: true`.

### 💰 Billing

Cost overview with product, organization, user, and cost center breakdowns. Trend charts for cost tracking. Requires `billing.enabled: true` (which also requires enterprise mode). Needs enterprise administration permissions on the PAT.

### 📈 Metered Usage

Detailed metered usage reports broken down by product, organization, and user. Requires `billing.meteredUsage: true`.

### ⚡ AI Credits

AI credit consumption with model-level breakdown and user-level analysis. Supports both legacy premium requests and the new AI credits billing model (effective June 2026). Requires `billing.premiumRequests: true` or `billing.aiCredits: true`.

### 📜 License & AI Credits

Per-user Copilot license lifecycle (assignment/revocation), negotiated cost, and AI-credit allowance vs. consumption, in three tabs: **Overview** (KPIs, plan/org breakdown, utilization, TCO), **Period Detail** (canonical per-user/org/month rows with identity/provenance columns and filters — only when historical sync has materialized data; otherwise the current live snapshot), and **Data Quality** (coverage, reconciliation checks, unresolved identities, source stats, run history, capability preflight). Requires `billing.premiumRequests: true` or `billing.aiCredits: true` (same rule as AI Credits, for either enabled globally or for any configured enterprise). See [Historical License Reconciliation](#historical-license-reconciliation) for the full data model.

### 👤 AI Credits by User

Sortable per-user AI credit consumption from the Usage Metrics API. Supports the global date range, enterprise/team/org scope filters, search, pagination, and CSV export.

---

## Page Visibility Reference

Which config toggles control the visibility of each sidebar page:

| Page | Visible When |
|------|-------------|
| Overview | `copilot.enabled` |
| Security | `codeScanning.enabled` OR `dependabot.enabled` OR `secretScanning.enabled` |
| Code Generation | `copilot.enabled` + `copilot.userMetrics` |
| Copilot Features | `copilot.enabled` + `copilot.userMetrics` |
| Model Statistics | `copilot.enabled` + `copilot.userMetrics` |
| CLI Analytics | `copilot.enabled` + `copilot.userMetrics` |
| Pull Requests | `copilot.enabled` |
| Team Analytics | `copilot.enabled` + `copilot.userMetrics` + `copilot.teams` |
| User Explorer | `copilot.enabled` + `copilot.userMetrics` |
| Seat Management | `copilot.enabled` + `copilot.seats` |
| IDE & Languages | `copilot.enabled` + `copilot.userMetrics` |
| Billing | `billing.enabled` + `copilot.enterprise` + `GITHUB_ENTERPRISE` env var |
| Metered Usage | Billing visible + `billing.meteredUsage` |
| AI Credits | Billing visible + `billing.premiumRequests` OR `billing.aiCredits` |
| License & AI Credits | Billing visible + `billing.premiumRequests` OR `billing.aiCredits` (globally, or for any configured enterprise in multi-enterprise mode) |
| AI Credits by User | `copilot.enabled` + `copilot.userMetrics` |

---

## Data Sync

### How It Works

1. **First sync** — Backfills data by fetching the `enterprise-1-day` and `users-1-day` endpoints for each day in the `BACKFILL_DAYS` range (default 90 days). Also syncs seats, teams, GHAS alerts, and billing data as configured. If `billing.licensing.history.enabled` is `true`, also runs the [historical license reconciliation sync](#historical-license-reconciliation) for each configured enterprise.
2. **Subsequent syncs** — Only fetches days that haven't been synced yet (incremental). Typically takes just a few seconds. Historical licensing periods with no source/config changes since the last run are skipped (see [below](#historical-license-reconciliation)); the current month is always refreshed.
3. **Data storage** — All data is stored in a local SQLite database at `data/copilot-metrics.db`. Pre-aggregated summary tables are refreshed after each sync for fast queries.

### Triggering a Sync

- **UI:** Click the **Sync** button in the dashboard header. Progress is shown in the header badge.
- **API:** Send a `POST` request to `/api/sync`. The sync runs in the background.

  ```bash
  # Start a sync
  curl -X POST http://localhost:3000/api/sync

  # Check sync status
  curl http://localhost:3000/api/sync
  ```

### Re-Sync (Force Refresh)

If you need to re-fetch data (e.g., after correcting permissions), use the `resync` parameter:

```bash
curl -X POST "http://localhost:3000/api/sync?resync=true"
```

This clears empty sync log entries and re-fetches data for those days.

### Rate Limiting

The sync service uses adaptive rate-limit tracking:
- **> 1,000 requests remaining:** No delay
- **100–1,000 remaining:** 200ms delay between requests
- **< 100 remaining:** Pauses until the rate limit resets

Automatic retries with exponential backoff are applied for `429` (rate limited) and `5xx` (server error) responses.

---

## Historical License Reconciliation

Native TypeScript/SQLite subsystem (`src/lib/licensing/`, `src/lib/db/license-*`) that reconstructs a per-user/per-org/per-billing-month license + AI-credit reconciliation history, functionally at parity with the standalone [`copilot-aic-report`](https://github.com/siddjoshi/github-copilot-billing-report) script's effective capabilities. It runs alongside — never in place of — the dashboard's existing live seat/billing sync.

### Parity overview

Ported: historical monthly seat ledger reconstruction, audit-log archive import, durable snapshots, deprovisioned/EMU identity recovery (SCIM/SAML/membership), account state, canonical per-user/org/month report grain, date-aware AI-credit allowances, direct per-user AI-credit API + CSV import, explicit source precedence, org-billing seat validation, login/status/history-quality checks, capability preflight, and machine-readable run diagnostics.

**Intentionally dashboard-native** (not ported, since the dashboard already exceeds the script here): model/cost-center breakdowns, chart visualizations, PDF export, multi-enterprise support, and the dashboard's existing scope filtering. The script's Python packaging/CLI/YAML config, its unwired `checkpoint.py`/`activity_window_days`/`billing_usage_max_months` options, and XLSX/HTML export are not applicable to a Next.js dashboard and are not parity requirements.

### Canonical grain and unattributed org semantics

The historical **detail** row is keyed by `(enterprise_slug, billing_period, org_login, holder_key)`. `org_login` is the literal string `"(unattributed)"` only when a source genuinely carries no org (e.g. an enterprise-wide AI-Credit result with no per-activity org attribution) — consumption is never copied across a multi-org user's other org seats. A separate **rollup** view aggregates by resolved login across selected orgs/periods for a user-centric summary. Both views are available via `view=detail|rollup` on the reconciliation API/export.

### Source precedence

**Seat/assignment history** (most to least authoritative): (1) a stored, authoritative monthly snapshot; (2) an audit-log-reconstructed `[assigned_at, revoked_at)` interval; (3) the current live seat snapshot, but *only* for the current billing month; (4) no fabricated row — an otherwise-unreconstructable period/holder is reported `unrecoverable`, never guessed.

**Identity resolution** (most to least authoritative): (1) the seat's own live `assignee.login`; (2) a real login observed in audit history for the same numeric GitHub user ID (recovers a real login even when the seat itself only shows an opaque/GUID-shaped value); (3) an enterprise SAML/SCIM identity mapping that explicitly supplies a verified login; (4) an organization SAML identity mapping (same verified-login rule); (5) a configured identity-map import (same rule); (6) a stable internal unresolved holder key — `user_login`/`resolved_user_login` stay empty, and an external identity (SAML NameID, SCIM external ID/username, email, etc.) is **never** promoted into either login field, only retained in `external_identity` for audit/diagnostics. External identities are never verified GitHub logins and are never exported in the UI or CSV.

**AI-Credit consumption** (most to least authoritative): (1) a configured CSV import for that period; (2) the enterprise-wide per-user AI-Credit API; (3) the per-organization AI-Credit API, but *only* when the enterprise-wide endpoint was unavailable for the entire run — an isolated 404 for one user is never a trigger, only a capability-wide failure (every requested holder receiving the same non-404 error) is; (4) synced `ai_credit` billing-report rows; (5) the Usage Metrics API's `ai_credits_used` as a current-period-only fallback, always tagged with its own distinct source. Every source's raw evidence is retained, but exactly one effective source is selected per (org, holder, period) before aggregation.

> **Current implementation note:** AI-Credit consumption records (from the per-user API or a CSV import) are always keyed to the holder by **login**, so they only join correctly to a holder whose own canonical key is also login-based (i.e. one with no numeric GitHub user ID on record) — a holder resolved via a numeric ID does not currently receive API/CSV-sourced consumption. Similarly, the `aic_gross_vs_net` reconciliation check currently always compares against a `null` net-of-discount comparator (net USD is captured and persisted per source, but not yet wired into that specific check), so it can only ever report `warning` ("no net comparator available"), never a real pass/fail, until a future net-comparator source (e.g. the synced billing report) is wired in.

### Confidence and account-state vocabulary

- **History confidence** (`history_confidence` column / API filter): `exact_snapshot` > `audit_reconstructed` > `live_snapshot_only` > `unrecoverable` (best to worst).
- **Account state** (`account_state`): `member` | `suspended` | `deprovisioned` | `unknown`.
- **Seat status** (`seat_status`): `active` | `inactive` | `no_seat`.
- **Reconciliation check status**: `pass` | `warning` | `fail`.
- **Overall run status**: `success` | `warning` | `failed` — derived from every check's status for that run (any `fail` → `failed`; else any `warning` → `warning`; else `success`; an empty check set never claims `success`). This reflects **data-quality findings** for the run, not process/crash status — a run can materialize every requested period cleanly and still report `failed` because, for example, a seat-count comparator genuinely disagreed with org billing, or a holder's history was genuinely unrecoverable.

### Reconciliation checks

Persisted per `(billing_period, org_login)` (or run-wide) after every enterprise's historical sync: `seat_count` (materialized active seats vs. an authoritative org-billing comparator, with a small tolerance before failing), `real_login_coverage` (% of holders resolved to a real login), `external_identity_leak` (a hard `fail` if any external identity ever appears in a login field — should never happen), `status_agreement` (seat activity vs. account state), `aic_gross_vs_net` (see note above — currently always `warning`), `consumption_attribution` (duplicate/ambiguous consumption attribution), and `history_coverage` (seat-ledger coverage confidence per period/org — `unrecoverable` coverage fails).

### Normal sync integration

Per enterprise, in order: preflight → configured imports (audit archive, identity map, AI-Credit CSV) → live seats + current-month authoritative snapshot (persisted *before* the legacy `copilot_seats` table is replaced) → audit-log API (bounded to the recoverable range) → membership/SCIM/SAML identities → org-billing summaries → AI-Credit consumption → seat-ledger + period materialization → reconciliation checks → durable run + diagnostics. One enterprise's failure never blocks another's sync (multi-enterprise isolation), and licensing sync never blocks or is blocked by the existing metrics/seats/teams/GHAS/billing sync phases. **The current month is always refreshed**; a historical period is skipped only when its complete SHA-256 source+config fingerprint exactly matches the prior successful run's.

### Backward compatibility and first-run behavior

- `copilot_seats`, `billing_usage_records`, and `billing_premium_requests` are never dropped, renamed, or recreated; every new table/column is additive (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN`).
- Before any historical sync has ever run (or when `billing.licensing.history.enabled` is unset/`false`), `/api/billing/license-reconciliation` transparently falls back to the existing live-snapshot query, and its response is tagged `coverage.mode: "live_snapshot_only"` / `dataSource: "live_snapshot_only"` — the current reconciliation view keeps working immediately after upgrading, with **no DB reset, no full re-sync, and no config changes required**.
- A missing/unavailable **optional** source (audit archive, identity map, membership/SCIM, org billing, AI-Credit CSV) degrades to a warning and valid (possibly partial/empty) data — never a 500 and never a failed sync on its own.
- Existing static `licenseCost`/`aicAllowance` config remains the fallback for any period not covered by a `datedAllowances` window.

### Configuration reference

All fields live under `metrics.billing.licensing` in `dashboard-config.json` and are entirely optional — every default below applies when unset. Per-enterprise overrides (multi-enterprise mode) currently cover only the *page-visibility* signal — see [`docs/multi-enterprise-setup.md`](docs/multi-enterprise-setup.md) for exactly what is/isn't per-enterprise today.

| Field | Type | Default | Notes |
|---|---|---|---|
| `creditToUsd` | number | `0.01` | USD value of one AI credit. |
| `currency` | string | `"USD"` | Display currency code. |
| `licenseCost` | `{business?, enterprise?, unknown?}` (USD) | `{business: 19, enterprise: 39, unknown: 0}` | Negotiated monthly seat price per plan. |
| `aicAllowance` | `{business?, enterprise?, unknown?}` (credits) | `{business: 1900, enterprise: 3900, unknown: 0}` | Monthly AI-credit allowance per plan; superseded by `datedAllowances` for periods they cover. |
| `perUserBudgetUsd` | `{ [login]: number }` | `{}` | Optional per-user AI-credit budget override (USD), keyed by login. |
| `datedAllowances` | `{start, end?, credits}[]` | `[]` | Time-bounded allowance overrides. `start`/`end` are `YYYY-MM-DD`, both inclusive; an absent `end` is open-ended. Windows must not overlap for the same plan — malformed/reversed/overlapping entries throw a validation error naming every problem found. |
| `history.enabled` | boolean | `false` | Master toggle for historical sync. |
| `history.reportMonths` | string \| string[] | current month | A single `"YYYY-MM"`, an inclusive `"YYYY-MM..YYYY-MM"` range, `"last_N_months"`, or an array mixing any of these. Capped at 120 months per range/token. |
| `history.auditRetentionDays` | number (1–3650) | `400` | How many days of seat assignment/revocation audit history to consider recoverable. |
| `history.emitSnapshots` | boolean | `false` | Also write a point-in-time JSON snapshot file per enterprise/period after each sync. |
| `history.snapshotDirectory` | string (server path) | `"data/licensing-snapshots"` | Where snapshot files are written. **Server-only — never returned by `/api/config`.** |
| `history.auditArchivePath` | string (server path) | `"data/licensing-audit"` | Configured audit-log archive import (JSON/NDJSON) file/directory. **Server-only — never returned by `/api/config`.** |
| `history.identityMapPath` | string (server path) | `"data/identity-map.json"` | Configured login/identity-map import file. **Server-only — never returned by `/api/config`.** |
| `identity.fetchMembership` | boolean | `false` | Fetch enterprise SCIM/membership records (account state, EMU support). |
| `identity.fetchEnterpriseIdentities` | boolean | `false` | Fetch enterprise-level SAML/SCIM identity mapping. |
| `identity.fetchOrgIdentities` | boolean | `false` | Fetch org-level SAML identity mapping. |
| `aicConsumption.mode` | `"auto"` \| `"billing_report"` \| `"per_user_api"` | `"auto"` | `"billing_report"` relies solely on already-synced billing reports/CSV import (no extra API calls); `"per_user_api"`/`"auto"` also fetch the per-user AI-Credit API. |
| `aicConsumption.csvPath` | string (server path) | unset | Optional CSV backfill/override, independent of `mode`. **Server-only — never returned by `/api/config`.** |
| `aicConsumption.concurrency` | number (1–20) | `4` | Max concurrent per-user AI-Credit API requests. |
| `validation.enabled` | boolean | `true` | Enable reconciliation checks. |
| `validation.aicTolerancePct` | number (0–100) | `5` | Tolerance before `aic_gross_vs_net` (see note above) would warn/fail. |

**File path ownership, size, and privacy:** every `*Path`/`*Directory` field above is server-side configuration only — never accepted from a query parameter, never echoed back by any API, and each configured import enforces a maximum file size and rejects a non-regular-file path (defense against path traversal / resource exhaustion). `/api/config` (used for sidebar/page-visibility) exposes only a computed `licensingHistoryEnabled: boolean` summary and each billing sub-toggle (`enabled`/`meteredUsage`/`premiumRequests`/`aiCredits`) — it never returns the `licensing` configuration block itself, so none of the fields above (paths, CSV sources, allowances, cost figures) ever reach the browser through it.

### API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/billing/license-reconciliation` | Detail/rollup JSON. Accepts `days`, `startDate`/`endDate`, or explicit `periods` (comma-separated `YYYY-MM`; precedence: `periods` > custom dates > `days`), `view=detail\|rollup`, `page`/`pageSize`/`sort`/`sortDir`/`search`, `teams`/`orgs`/`enterprises`, and `plan`/`accountState`/`seatStatus`/`historyConfidence` filters. Falls back to the legacy live query (`coverage.mode: "live_snapshot_only"`) when no materialized history exists for the requested scope. |
| `GET /api/billing/license-reconciliation/runs?enterprise=<slug>` | Recent sync run summaries for one enterprise (`limit`, default 20, max 100) — sanitized: never raw `sourceStats`/checks/unresolved-identity detail. |
| `GET /api/billing/license-reconciliation/runs/[id]?enterprise=<slug>` | Full sanitized run report (checks, source stats, unresolved-identity counts, warnings) as `format=json` (default) or `format=text`. |
| `GET /api/billing/license-reconciliation/preflight?enterprise=<slug>` | Per-capability preflight result (see [Capability preflight](#capability-preflight-classic-vs-fine-grained-pats)) — never exposes the token or raw scope header. |
| `GET /api/export/license-reconciliation` | Server-generated UTF-8 CSV for `view=detail\|rollup`, using the same period/scope/filter query params as the JSON route above. Bounded (rejects with a descriptive 400 instead of an unbounded/truncated export when the result is too large). |

**PDF export:** the License & AI Credits page's PDF export (via the page's Export menu) renders the Overview and Data Quality panel sections as a screenshot-based PDF, the same mechanism used by every other chart-heavy dashboard page — it does not include the paginated Period Detail table. **CSV export:** the page's own Export → CSV button already calls the dedicated server-side `GET /api/export/license-reconciliation` endpoint documented above (via `useExport`'s `/api/billing/license-reconciliation` → `/api/export/license-reconciliation` rewrite, `src/hooks/useExport.ts`) with the page's current period/view/scope/filter selection — a single bounded server-side request, not a client-side page loop — so it exports the full historical detail/rollup CSV whenever historical data exists, falling back only to the legacy live-snapshot CSV when it doesn't (same fallback rule as the JSON API).

### Troubleshooting

- **401/403 during licensing sync** — check `GET /api/billing/license-reconciliation/preflight?enterprise=<slug>` first; a 401/403 on the identity check itself means the configured credential is invalid, not just missing a scope.
- **Missing/native SQLite locally** — `better-sqlite3`'s native binding may not load on newer local Node versions; the dashboard app itself is unaffected (bundled/prebuilt binary), but if you see native-binding errors in a dev/test tool, use a matching Node LTS version.
- **Missing identity/history/optional sources** — expected to show as `warning`s in a run's diagnostics (`GET .../runs/[id]`), not errors; the affected fields simply stay `unknown`/absent rather than fabricated.
- **Gross vs. net mismatch never fails** — see the [source-precedence note](#source-precedence) above; this is current, documented behavior, not a misconfiguration.
- **CSV/archive import parsing or size failures** — reported as a source warning (`audit_archive_import` / `identity_map_import` / `aic_csv_import` / `aic_consumption` source state), with the run otherwise completing; check the run's `format=text` diagnostics for the exact reason (file not found, not a regular file, over the size cap, invalid UTF-8, or malformed rows).
- **"License & AI Credits" missing from the sidebar** — requires `billing.premiumRequests: true` or `billing.aiCredits: true` (globally, or for any configured enterprise) — same rule as the AI Credits page.

---

## Filtering & Scope

### Global Scope Filter

The dashboard header includes a scope filter that lets you narrow data across **all** pages by:
- **Enterprise teams** — filter by team membership at the enterprise level
- **Organization teams** — filter by team membership within an org
- **Organizations** — filter by specific organizations

When a scope filter is active, all API queries are scoped to the selected teams/orgs.

### Date Range Presets

The header provides quick date range toggles:

| Preset | Days |
|--------|------|
| 7 days | 7 |
| 14 days | 14 |
| 28 days | 28 |
| 90 days | 90 |
| 180 days | 180 |
| 365 days | 365 |

The default view is **7 days**. The selected range applies to all pages.

---

## Exporting Data

The dashboard supports exporting data from most pages via the **Export** button.

| Export Type | Available On | Format |
|-------------|-------------|--------|
| **CSV** | Users, Teams, Seats | `.csv` file with all rows (fetched across all pages) |
| **PDF** | Overview, Models, IDE & Languages, Code Generation, Pull Requests, Security | Screenshot of the current page as a `.pdf` |
| **Both** | Copilot Features, CLI Analytics | Choose CSV or PDF from the dropdown |
| **Both** | License & AI Credits | CSV calls the dedicated server-side `GET /api/export/license-reconciliation` endpoint with the page's current period/view/scope/filter selection (full historical detail/rollup with all provenance columns, falling back to the legacy live-snapshot CSV only when no historical data exists); PDF screenshots the Overview + Data Quality panels. See [Historical License Reconciliation](#historical-license-reconciliation). |

CSV exports fetch all paginated data (not just the current page view) so you get a complete dataset.

---

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Charts | Recharts |
| UI | shadcn/ui + Tailwind CSS v4 |
| Database | SQLite (better-sqlite3, WAL mode) |
| Data Fetching | @tanstack/react-query |
| Export | jspdf + html2canvas (PDF), custom CSV generator |
| Icons | Lucide React |

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Next.js Frontend                               │
│  Overview │ Security │ Code Gen │ Features │ Models │ CLI │ PRs     │
│  Teams │ Users │ Seats │ IDE & Langs │ Billing │ Usage │ Premium   │
│  License & AI Credits (Overview / Period Detail / Data Quality)     │
├─────────────────────────────────────────────────────────────────────┤
│              Next.js API Routes (with TTL cache)                     │
│              Server-side pagination, sorting, search                 │
│  /api/billing/license-reconciliation(/runs, /runs/[id], /preflight) │
│  /api/export/license-reconciliation                                  │
├─────────────────────────────────────────────────────────────────────┤
│   In-Memory TTL Cache (LRU)  │  Pre-Aggregated Summary Tables       │
├─────────────────────────────────────────────────────────────────────┤
│               SQLite  (data/copilot-metrics.db)                      │
│   user_daily_metrics │ seats │ teams │ ghas_* │ billing_*           │
│   license_seat_snapshots │ license_audit_events │ license_period_rows │
│   license_identity_records │ license_aic_consumption │ license_reconciliation_runs/checks │
├─────────────────────────────────────────────────────────────────────┤
│                      GitHub APIs                                     │
│  Copilot Metrics (enterprise-1-day, users-1-day, org-1-day)         │
│  Seats │ Teams │ GHAS (code scanning, dependabot, secret scanning)  │
│  Billing (metered usage, AI credits / premium requests)               │
│  Audit log │ Enterprise/org SCIM+SAML identity │ Org Copilot billing│
│  Per-user AI-Credit usage (enterprise + org)                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Performance

- **Pre-aggregated summary tables** (`user_period_summary`, `daily_aggregate_cache`, `team_summary_cache`) are refreshed after each sync so API routes serve fast queries instead of scanning raw metrics.
- **In-memory TTL cache** with LRU eviction wraps all API routes for sub-millisecond repeated reads.
- **Server-side pagination** on Users, Teams, and Seats pages keeps frontend payloads small.

### Team-Level Metrics (Computed)

The GitHub API does not provide native team-level Copilot metrics. This dashboard computes them by:
1. Fetching user-level daily metrics via the `users-1-day` endpoint
2. Fetching team membership via the Teams API
3. Cross-referencing and aggregating metrics per team


---

## Production Deployment

```bash
# Build for production
npm run build

# Start the production server
npm start
```

The production server runs on port 3000 by default. The SQLite database is stored at `data/copilot-metrics.db` — ensure this directory is persistent and writable.

> **Important:** Since the dashboard uses a file-based SQLite database, it is designed for single-instance deployment. If you need multi-instance, consider placing the `data/` directory on a shared volume.

---

## Troubleshooting

### Dashboard is empty after sync

- Check the browser console and server logs for errors.
- Verify your `GITHUB_TOKEN` has the correct scopes (see [Prerequisites](#prerequisites)).
- Ensure `GITHUB_ENTERPRISE` matches your enterprise slug exactly (case-sensitive).
- Try a re-sync: `curl -X POST "http://localhost:3000/api/sync?resync=true"`

### "GITHUB_TOKEN environment variable is required"

Your `.env.local` file is missing or the `GITHUB_TOKEN` variable is not set. Ensure the file exists at the project root and contains a valid token.

### Pages are missing from the sidebar

Pages are hidden based on `dashboard-config.json` settings. Check the [Page Visibility Reference](#page-visibility-reference) to see which toggles control each page.

### Rate limit errors during sync

The sync service handles rate limits automatically with adaptive delays. If you still hit limits:
- Reduce `BACKFILL_DAYS` to a smaller value
- Wait for your rate limit to reset (shown in server logs)
- Consider using a PAT with higher rate limits

### Billing pages not showing

Billing requires **all** of the following:
1. `billing.enabled: true` in `dashboard-config.json`
2. `copilot.enterprise: true` in `dashboard-config.json`
3. `GITHUB_ENTERPRISE` environment variable set
4. A PAT with `Enterprise administration` (write) permission

### GHAS Security page not showing

At least one of `codeScanning`, `dependabot`, or `secretScanning` must be `enabled: true` in `dashboard-config.json`. Also ensure your PAT has the `security_events` scope.

### "Failed to read dashboard-config.json"

This warning in server logs means the config file is missing or malformed. The dashboard falls back to defaults (all Copilot features enabled, GHAS enabled, billing disabled). Create or fix `dashboard-config.json` in the project root.

### Sync seems stuck

Check the sync status via API: `curl http://localhost:3000/api/sync`. If `syncInProgress` is `true` for an extended period, check server logs for errors. The sync lock is released when the sync completes or fails.

### "License & AI Credits" page not showing historical data

See the dedicated [Historical License Reconciliation](#historical-license-reconciliation) section — in particular its [Troubleshooting](#troubleshooting-1) subsection for licensing-specific 401/403, missing-source, and reconciliation-check questions.

---

## License

MIT
