# Multi-Enterprise Setup Guide

Track multiple GitHub Enterprise accounts from a single dashboard instance. Each enterprise gets its own authentication, org list, and data isolation — while sharing one UI and SQLite database.

## Prerequisites

- A running instance of the GHCP Usage Dashboard (see [README](../README.md) for initial setup)
- A GitHub PAT (or GitHub App) **per enterprise** with the required scopes (see README Prerequisites)
- Enterprise slugs for each enterprise (found at `github.com/enterprises/<slug>`)

## Configuration

### Step 1: Define enterprises in `dashboard-config.json`

Add an `enterprises` array to your `dashboard-config.json`:

```json
{
  "enterprises": [
    {
      "slug": "enterprise-one",
      "displayName": "Enterprise One",
      "tokenEnvVar": "GITHUB_TOKEN_ENT1",
      "appIdEnvVar": "GITHUB_APP_ID_ENT1",
      "appPrivateKeyEnvVar": "GITHUB_APP_KEY_ENT1",
      "appInstallationIdEnvVar": "GITHUB_APP_INST_ENT1",
      "organizations": {
        "include": ["org-alpha", "org-beta"],
        "exclude": []
      }
    },
    {
      "slug": "enterprise-two",
      "displayName": "Enterprise Two",
      "tokenEnvVar": "GITHUB_TOKEN_ENT2",
      "organizations": {
        "include": ["org-gamma", "org-delta"],
        "exclude": []
      }
    }
  ],
  "metrics": {
    "copilot": { "enabled": true, "enterprise": true, "userMetrics": true, "seats": true, "teams": true },
    "codeScanning": { "enabled": true },
    "dependabot": { "enabled": true },
    "secretScanning": { "enabled": true },
    "billing": { "enabled": true, "meteredUsage": true, "premiumRequests": true }
  },
  "security": { "syncIntervalMinutes": 60, "backfillDays": 90 },
  "autoSync": { "enabled": false, "utcTime": "03:00" }
}
```

### Step 2: Set per-enterprise environment variables in `.env.local`

Each enterprise references its auth credentials via env var **names** defined in the config above:

```bash
# Enterprise One — PAT + GitHub App
GITHUB_TOKEN_ENT1=ghp_aaaa...
GITHUB_APP_ID_ENT1=123456
GITHUB_APP_KEY_ENT1="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_INST_ENT1=78901234

# Enterprise Two — PAT only
GITHUB_TOKEN_ENT2=ghp_bbbb...

# Optional: backfill range (shared across all enterprises)
BACKFILL_DAYS=90
```

> **Note:** When the `enterprises` array is present in `dashboard-config.json`, the legacy `GITHUB_ENTERPRISE`, `GITHUB_TOKEN`, and `GITHUB_ORGS` environment variables are **ignored**.

### Step 3: Run initial sync

Start the dashboard and trigger a full sync. The sync loops over each configured enterprise sequentially:

```bash
npm run dev
# Then visit http://localhost:3000 and trigger a sync from the UI
```

## Enterprise Config Reference

| Field | Required | Description |
|-------|----------|-------------|
| `slug` | **Yes** | Enterprise slug as shown in `github.com/enterprises/<slug>` |
| `displayName` | **Yes** | Human-readable label shown in the dashboard UI |
| `tokenEnvVar` | **Yes** | Name of the env var holding the PAT for this enterprise |
| `appIdEnvVar` | No | Env var for GitHub App ID (enables App auth for org-level endpoints) |
| `appPrivateKeyEnvVar` | No | Env var for GitHub App private key PEM |
| `appInstallationIdEnvVar` | No | Env var for GitHub App installation ID |
| `organizations.include` | No | Org slugs to sync for this enterprise. **If empty or omitted, all orgs are auto-discovered from the enterprise API on each sync.** |
| `organizations.exclude` | No | Org slugs to exclude (subtracted from `include` list or from auto-discovered orgs) |
| `metrics` | No | Per-enterprise metric overrides. Shallow-merges with global `metrics` config. See below. |

### Per-enterprise metric overrides

Each enterprise can override any global metric toggle. When a field is omitted, the global config value is used.

```json
{
  "enterprises": [
    {
      "slug": "enterprise-one",
      "displayName": "Enterprise One",
      "tokenEnvVar": "GITHUB_TOKEN_ENT1",
      "metrics": {
        "copilot": { "pullRequests": false },
        "codeScanning": { "enabled": false },
        "billing": { "enabled": true, "premiumRequests": false }
      }
    },
    {
      "slug": "enterprise-two",
      "displayName": "Enterprise Two",
      "tokenEnvVar": "GITHUB_TOKEN_ENT2",
      "metrics": {
        "codeScanning": { "enabled": true, "autofix": true }
      }
    }
  ]
}
```

Available override fields:

| Category | Fields |
|----------|--------|
| `copilot` | `enabled`, `enterprise`, `userMetrics`, `seats`, `teams`, `pullRequests` |
| `codeScanning` | `enabled`, `autofix` |
| `dependabot` | `enabled` |
| `secretScanning` | `enabled` |
| `billing` | `enabled`, `meteredUsage`, `premiumRequests` |

**Page visibility**: A dashboard page is shown if the metric is enabled for **any** configured enterprise. For example, if code scanning is disabled globally but enabled for one enterprise, the security pages will still appear.

### Authentication per enterprise

- **PAT only** — Set only `tokenEnvVar`. The PAT is used for all API calls.
- **PAT + GitHub App** — Set all four auth fields. The App handles org-level endpoints; the PAT handles enterprise-level endpoints (which GitHub Apps cannot access).

## Migrating from Single-Enterprise Mode

If you already have synced data from single-enterprise mode:

1. **Your existing data is preserved.** On startup, the dashboard automatically backfills the `enterprise_slug` column on legacy rows (rows with empty `enterprise_slug`) using the configured enterprise slug.

2. **No re-sync required for existing data.** As long as your new enterprise config uses the **same slug** as your old `GITHUB_ENTERPRISE` env var, all historical data remains accessible.

3. **Add the second enterprise.** Data for the new enterprise will be fetched on the next sync. The first enterprise's historical data is untouched.

### Migration steps

```bash
# Before (single-enterprise in .env.local):
GITHUB_ENTERPRISE=my-company
GITHUB_TOKEN=ghp_xxxx
GITHUB_ORGS=org1,org2

# After (multi-enterprise in dashboard-config.json):
# 1. Add enterprises array to dashboard-config.json with slug "my-company"
#    (same as old GITHUB_ENTERPRISE) plus the new enterprise
# 2. Move token to a named env var:
GITHUB_TOKEN_ENT1=ghp_xxxx       # same token, renamed
GITHUB_TOKEN_ENT2=ghp_yyyy       # new enterprise token
# 3. Remove old vars (optional, they're ignored when enterprises array exists):
# GITHUB_ENTERPRISE=  (ignored)
# GITHUB_TOKEN=       (ignored)
# GITHUB_ORGS=        (ignored)
```

> **Important:** If you change the enterprise slug (e.g., from `my-company` to `my-company-prod`), the existing data won't automatically map to the new slug. Use the same slug to preserve historical data continuity.

## How It Works

### Data isolation

Each enterprise's data is stored with its `enterprise_slug` as part of the primary key across all tables. This means:

- Metrics, seats, teams, GHAS alerts, and billing data are scoped per enterprise
- Summary tables aggregate within each enterprise
- The UI's scope filter lets users select which enterprise(s) to view

### Sync behavior

- `fullSync()` iterates over all configured enterprises sequentially
- **Organization auto-discovery**: If `organizations.include` is empty (or omitted), the sync fetches all orgs from `GET /enterprises/{slug}/organizations` and caches them in the `enterprise_orgs` DB table. The `exclude` array is still applied to filter out unwanted orgs.
- Each enterprise's metrics, seats, teams, GHAS, and billing are synced independently
- Summary tables are refreshed once after all enterprises complete
- Incremental sync also loops over all enterprises and refreshes the org list

### Security API defaults

When security pages don't specify an explicit enterprise scope, the dashboard defaults to the **first configured enterprise**. Use the scope filter in the UI to switch between enterprises.

## Example Configurations

### Two enterprises, one with GitHub App

```json
{
  "enterprises": [
    {
      "slug": "acme-corp",
      "displayName": "Acme Corporation",
      "tokenEnvVar": "ACME_PAT",
      "appIdEnvVar": "ACME_APP_ID",
      "appPrivateKeyEnvVar": "ACME_APP_KEY",
      "appInstallationIdEnvVar": "ACME_APP_INST",
      "organizations": { "include": ["acme-engineering", "acme-data"] }
    },
    {
      "slug": "subsidiary-inc",
      "displayName": "Subsidiary Inc",
      "tokenEnvVar": "SUB_PAT",
      "organizations": { "include": ["subsidiary-dev"] }
    }
  ]
}
```

### PAT-only setup (simplest)

```json
{
  "enterprises": [
    {
      "slug": "company-a",
      "displayName": "Company A",
      "tokenEnvVar": "TOKEN_A",
      "organizations": { "include": ["company-a-org1", "company-a-org2"] }
    },
    {
      "slug": "company-b",
      "displayName": "Company B",
      "tokenEnvVar": "TOKEN_B",
      "organizations": { "include": ["company-b-org1"] }
    }
  ]
}
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No enterprises configured" on sync | `enterprises` array missing or empty in `dashboard-config.json` | Add the `enterprises` array (see Step 1 above) |
| "PAT not found" error for an enterprise | The env var named in `tokenEnvVar` is not set | Set the env var in `.env.local` |
| Enterprise data not syncing | `copilot.enterprise` is `false` in config | Set `"enterprise": true` in `metrics.copilot` |
| Billing disabled despite config | `copilot.enterprise` must be `true` for billing | Ensure enterprise mode is enabled |
| Old data missing after switching slugs | Enterprise slug changed from legacy value | Use the same slug as the old `GITHUB_ENTERPRISE` value |
| Security page shows wrong enterprise | Default scope picks first configured enterprise | Use scope filter in UI, or pass `?scope=enterprise&scopeId=<slug>` |
| Orgs not showing in dashboard | `organizations.include` is empty and sync hasn't run yet | Run a full sync — orgs will be auto-discovered from the enterprise API |
