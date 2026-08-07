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
| **👤 AI Credits by User** | Sortable user-level AI credit consumption table |

### Additional Capabilities

- **🌙 Dark / Light Mode** — full theme support, toggled from the header
- **📥 Export** — CSV for table pages, PDF screenshots for chart pages
- **🔍 Scope Filtering** — filter all pages by enterprise team, org team, or organization
- **📅 Date Range Presets** — 7, 14, 28, 90, 180, or 365 day windows

---

## Prerequisites

- **Node.js 20+** (with npm)
- A **GitHub Personal Access Token** (classic or fine-grained) with scopes appropriate for the features you enable:

| Feature | Classic PAT Scope | Fine-Grained PAT Permission |
|---------|-------------------|----------------------------|
| Copilot enterprise metrics | `manage_billing:copilot` or `read:enterprise` | — |
| Organization metrics | `read:org` | Organization: Read |
| Enterprise teams | `read:enterprise` | — |
| GHAS (Security) | `security_events` | `code_scanning_alerts:read`, `dependabot_alerts:read`, `secret_scanning_alerts:read` |
| Billing | — | Enterprise: `Enterprise administration` (write) |

> **Tip:** If you only need Copilot metrics (no GHAS or billing), a classic PAT with `manage_billing:copilot` + `read:org` is sufficient.

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
      "aiCredits": true          // Sync AI credit reports (new billing model)
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
| AI Credits by User | `copilot.enabled` + `copilot.userMetrics` |

---

## Data Sync

### How It Works

1. **First sync** — Backfills data by fetching the `enterprise-1-day` and `users-1-day` endpoints for each day in the `BACKFILL_DAYS` range (default 90 days). Also syncs seats, teams, GHAS alerts, and billing data as configured.
2. **Subsequent syncs** — Only fetches days that haven't been synced yet (incremental). Typically takes just a few seconds.
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
├─────────────────────────────────────────────────────────────────────┤
│              Next.js API Routes (with TTL cache)                     │
│              Server-side pagination, sorting, search                 │
├─────────────────────────────────────────────────────────────────────┤
│   In-Memory TTL Cache (LRU)  │  Pre-Aggregated Summary Tables       │
├─────────────────────────────────────────────────────────────────────┤
│               SQLite  (data/copilot-metrics.db)                      │
│   user_daily_metrics │ seats │ teams │ ghas_* │ billing_*           │
├─────────────────────────────────────────────────────────────────────┤
│                      GitHub APIs                                     │
│  Copilot Metrics (enterprise-1-day, users-1-day, org-1-day)         │
│  Seats │ Teams │ GHAS (code scanning, dependabot, secret scanning)  │
│  Billing (metered usage, AI credits / premium requests)               │
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

---

## License

MIT
