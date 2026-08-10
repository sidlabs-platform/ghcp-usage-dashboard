# Licensing integration fixtures

Deterministic, sanitized fixture data for the historical license reconciliation
subsystem (`src/lib/licensing/`, `src/lib/db/license-history-*`, and the
`/api/billing/license-reconciliation*`/`/api/export/license-reconciliation`
routes).

## Safety rules (non-negotiable)

- **No real user data.** Every login, org, enterprise slug, and numeric GitHub
  user ID here is fabricated for this fixture set (`alice`, `bob`, `ent-alpha`,
  `alpha-eng`, id `101`, etc.) — none correspond to real accounts.
- **No tokens, secrets, or credentials** of any kind, real or fake-but-realistic
  (no `ghp_...`-shaped strings).
- **Emails only where an email-shaped external identity is required** for a
  safety assertion (e.g. proving an external identity is never promoted into
  `user_login`), and only under `@example.test`/`@example.invalid` (reserved,
  non-routable domains per RFC 2606).
- **No raw source payloads** beyond what a real (sanitized) GitHub API/SCIM/SAML
  response would plausibly contain structurally — `raw` fields are small,
  synthetic stand-ins, not captured real traffic.

## Layout

| File | Scenario coverage |
|---|---|
| `identifiers.ts` | Shared enterprise/org/period constants used across every other fixture file. |
| `seats.ts` | Live (current-period) Copilot seats — active, multi-org, and an obfuscated/unresolved holder. |
| `audit-events.ts` | Seat lifecycle audit events — assign/cancel/reassign — plus an archive-import + live-API duplicate pair (overlap/dedupe). |
| `identities.ts` | Enterprise/org SAML identity records and enterprise SCIM membership records — including `suspended`/`deprovisioned` account states. |
| `allowances.ts` | A dated AI-Credit allowance window change (static default vs. a historical override effective mid-scenario). |
| `aic-consumption.ts` | Per-user AI-Credit API results — enterprise-wide success, an isolated per-user 404 (never triggers fallback), and an enterprise-wide failure that forces an org-scoped fallback — plus a CSV-imported historical-period record and gross-vs-net figures. |
| `org-billing.ts` | Per-org billing snapshots, including one `unavailable` (missing optional source) result. |
| `index.ts` | Barrel export plus `TWO_ENTERPRISE_SCENARIO`, a composed bundle combining every fixture above into a ready-to-inject two-enterprise, three-billing-month scenario. |

## Usage

Import `TWO_ENTERPRISE_SCENARIO` from `./index` to build a
`LicenseHistorySyncDeps` override set (see
`src/lib/db/license-history-parity.integration.test.ts` for a full example),
or import individual builders directly for a narrower, single-scenario test.
