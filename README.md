# GitHub Copilot Enterprise Usage Metrics Dashboard

A comprehensive, beautiful dashboard for visualizing GitHub Copilot usage metrics across your enterprise, organizations, teams, and individual users.

## Features

- **📊 Executive Overview** — KPI cards, active user trends (90-day default), acceptance rates, chat mode distribution
- **💻 Code Generation** — Lines of code metrics, user vs agent code changes, language/model breakdowns
- **💬 Chat & AI Modes** — Ask/Edit/Plan/Agent/Custom mode tracking, model usage, adoption trends
- **⌨️ CLI Analytics** — Copilot CLI sessions, requests, token consumption, version distribution
- **🔀 Pull Request Impact** — PR lifecycle, Copilot vs human comparison, merge time analysis
- **👥 Team Analytics** — Computed team-level metrics (not natively available in API), leaderboard, adoption heatmap
- **👤 User Explorer** — Individual user drill-down, feature adoption per user
- **💳 Seat Management** — License utilization, idle seat detection, team assignment distribution
- **🖥️ IDE & Languages** — IDE distribution, language heatmap, version tracking
- **🌙 Dark Mode** — Full dark/light theme support

## Data Source

Uses the **new GitHub Copilot Usage Metrics API** (GA February 2026):
- `GET /enterprises/{ent}/copilot/metrics/reports/enterprise-1-day?day=YYYY-MM-DD` — Primary endpoint, fetched day-by-day for 90+ days of history
- `GET /enterprises/{ent}/copilot/metrics/reports/users-1-day?day=YYYY-MM-DD` — Per-user metrics
- `GET /orgs/{org}/copilot/metrics/reports/organization-1-day?day=YYYY-MM-DD` — Per-org metrics
- Seat Management API for license data
- Teams API for team membership (used to compute team-level metrics)

Data is persisted in a local SQLite database for fast queries across any date range.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Charts | Recharts |
| UI | shadcn/ui + Tailwind CSS v4 |
| Database | SQLite (better-sqlite3) |
| Icons | Lucide React |

## Getting Started

### Prerequisites
- Node.js 20+
- A GitHub Personal Access Token with:
  - `manage_billing:copilot` or `read:enterprise` scope (enterprise endpoints)
  - `read:org` scope (organization endpoints)
  - `read:enterprise` scope (enterprise teams, if used)

### Setup

```bash
# Clone the repository
git clone <repo-url>
cd ghcp-usage-dashboard

# Install dependencies
npm install

# Configure environment
cp .env.local.example .env.local
# Edit .env.local with your token and enterprise slug

# Start development server
npm run dev
```

### Environment Variables

```env
# Required
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_ENTERPRISE=your-enterprise-slug

# Optional
GITHUB_ORGS=org1,org2,org3      # Comma-separated org slugs
BACKFILL_DAYS=90                  # Days to backfill (default: 90, max: 365)
```

### First-Time Data Sync

1. Start the dev server: `npm run dev`
2. Open http://localhost:3000
3. Click the **Sync** button in the header
4. The dashboard will backfill 90 days of data using the `enterprise-1-day` endpoint (~3-5 minutes)
5. Subsequent syncs only fetch missing days (incremental)

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Next.js Frontend                       │
│  Overview │ Code Gen │ Chat │ CLI │ PRs │ Teams │ Users  │
├──────────────────────────────────────────────────────────┤
│                  Next.js API Routes                       │
├──────────────────────────────────────────────────────────┤
│            SQLite (data/copilot-metrics.db)               │
├──────────────────────────────────────────────────────────┤
│  GitHub APIs (Usage Metrics │ Seats │ Teams)              │
│  enterprise-1-day endpoint × 90 days = full history       │
└──────────────────────────────────────────────────────────┘
```

### Team-Level Metrics (Computed)

The GitHub API does not provide direct team-level metrics. This dashboard computes them by:
1. Fetching user-level daily metrics via `users-1-day` endpoint
2. Fetching team membership via the Teams API
3. Cross-referencing and aggregating per-team

## License

MIT
