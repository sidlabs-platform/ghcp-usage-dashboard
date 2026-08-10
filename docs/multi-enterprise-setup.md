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
| `billing` | `enabled`, `meteredUsage`, `premiumRequests`, `aiCredits`, `licensingHistoryEnabled` |

**Page visibility**: A dashboard page is shown if the metric is enabled for **any** configured enterprise. For example, if code scanning is disabled globally but enabled for one enterprise, the security pages will still appear. The **License & AI Credits** page follows the same rule as **AI Credits**: visible when `billing.premiumRequests` or `billing.aiCredits` is enabled globally, or for any configured enterprise.

### Per-enterprise historical licensing visibility (`licensingHistoryEnabled`)

`metrics.billing.licensing` (see the [README's Historical License Reconciliation section](../README.md#historical-license-reconciliation) for the full field reference) is a single **global** configuration block — every configured enterprise's historical sync currently reads the exact same resolved `licensing.history.*`, `identity.*`, `aicConsumption.*`, `validation.*`, `datedAllowances`, and pricing settings. There is presently no way to give two enterprises different report-month ranges, different allowance schedules, different import file paths, or a different AI-Credit consumption mode.

What **is** per-enterprise today is the narrow `billing.licensingHistoryEnabled` override — a safe boolean (never the underlying `LicensingConfig` shape, so no server path/secret can be introduced at this layer) that controls the *page-visibility / config-exposure* signal `isLicensingHistoryEnabledForEnterprise()`/`isLicensingHistoryEnabledForAnyEnterprise()` compute for `/api/config`'s `licensingHistoryEnabled` field:

```json
{
  "enterprises": [
    {
      "slug": "enterprise-one",
      "displayName": "Enterprise One",
      "tokenEnvVar": "GITHUB_TOKEN_ENT1",
      "metrics": {
        "billing": { "aiCredits": true, "licensingHistoryEnabled": true }
      }
    },
    {
      "slug": "enterprise-two",
      "displayName": "Enterprise Two",
      "tokenEnvVar": "GITHUB_TOKEN_ENT2",
      "metrics": {
        "billing": { "aiCredits": true, "licensingHistoryEnabled": false }
      }
    }
  ],
  "metrics": {
    "billing": { "enabled": true, "aiCredits": true, "licensing": { "history": { "enabled": true } } }
  }
}
```

When omitted (every pre-existing enterprise entry), an enterprise falls back to the global `licensing.history.enabled` flag unchanged — fully backward-compatible, no migration required. Billing must also be enabled for that enterprise (mirrors every other `billing.*` sub-toggle); if it isn't, `licensingHistoryEnabled` reports `false` for that enterprise regardless of the override.

> **Important:** this override does not (yet) change *whether the historical sync itself runs* for an enterprise — `license-history-sync-service.ts` still reads the single global `licensing.history.enabled` flag for every configured enterprise's actual sync. Setting `licensingHistoryEnabled: false` for one enterprise hides/adjusts the safe visibility signal exposed to the browser; it does not skip that enterprise's sync. Full per-enterprise sync-level control (distinct report months, allowances, or import paths per enterprise) is not implemented.

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
- Historical licensing data (`license_seat_snapshots`, `license_period_rows`, `license_reconciliation_runs`, etc.) is likewise keyed by `enterprise_slug` and fully isolated per enterprise — one enterprise's licensing sync failure never affects another's, and each enterprise gets its own run history/diagnostics

### Sync behavior

- `fullSync()` iterates over all configured enterprises sequentially
- **Organization auto-discovery**: If `organizations.include` is empty (or omitted), the sync fetches all orgs from `GET /enterprises/{slug}/organizations` and caches them in the `enterprise_orgs` DB table. The `exclude` array is still applied to filter out unwanted orgs.
- Each enterprise's metrics, seats, teams, GHAS, and billing are synced independently
- When `billing.licensing.history.enabled` is `true`, historical license reconciliation also runs per enterprise (after that enterprise's seats/billing sync), isolated the same way — see the [README's Historical License Reconciliation section](../README.md#historical-license-reconciliation) for the full sync/config contract, and [above](#per-enterprise-historical-licensing-visibility-licensinghistoryenabled) for exactly what is/isn't configurable per enterprise today
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
| One enterprise's license history looks disabled/enabled unexpectedly | Per-enterprise `billing.licensingHistoryEnabled` override takes precedence over the global `licensing.history.enabled` flag for that enterprise's page-visibility signal | Check that enterprise's `metrics.billing.licensingHistoryEnabled` in `dashboard-config.json`; remove the override to fall back to the global flag |
| Historical licensing sync still runs for an enterprise after setting `licensingHistoryEnabled: false` | Expected today — that override only affects the safe visibility signal exposed via `/api/config`, not the sync itself (see [above](#per-enterprise-historical-licensing-visibility-licensinghistoryenabled)) | Disable `metrics.billing.licensing.history.enabled` globally if you need to stop the sync for every enterprise |
