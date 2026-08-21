/**
 * Chart colour palette — one semantic meaning per hex.
 *
 * Organised into domain sub-palettes so reuse across domains is explicit, not
 * accidental.  Within each sub-palette every entry has a distinct hue or
 * lightness so series remain separable at small sizes and under deuteranopia.
 *
 * Chat-mode palette rationale (deuteranopia safety):
 *   ask  = blue  (H 217) — safe anchor
 *   edit = teal  (H 172) — large blue-green gap, unambiguous under deutan
 *   plan = amber (H 38)  — yellow-orange, maximally distant from blue/teal
 *   agent= rose  (H 351) — red-pink, separable from all above
 *   custom & unknown retain pink/slate as they are already well-separated.
 */
export const CHART_COLORS = {
  // ── Chat modes (span the colour wheel; deutan-safe) ─────────────────────
  ask:     "#3b82f6",  // blue-500   H 217
  edit:    "#14b8a6",  // teal-500   H 172  (was violet-500 — deutan-collision fixed)
  plan:    "#f59e0b",  // amber-500  H  38  (was purple-500 — deutan-collision fixed)
  agent:   "#f43f5e",  // rose-500   H 351  (was indigo-500 — deutan-collision fixed)
  custom:  "#ec4899",  // pink-500   H 330
  unknown: "#94a3b8",  // slate-400

  // ── Feature-level series ─────────────────────────────────────────────────
  completions: "#0ea5e9", // sky-500    H 199  (completion suggestions)
  chat:        "#6366f1", // indigo-500 H 239  (chat-panel aggregate; distinct from completions)
  cli:         "#10b981", // emerald-500 H 152
  codeReview:  "#f59e0b", // amber-500  H  38

  // ── General / semantic tokens ────────────────────────────────────────────
  primary:   "#3b82f6",  // blue-500
  secondary: "#6366f1",  // indigo-500 (distinct from primary)
  success:   "#10b981",  // emerald-500
  warning:   "#f59e0b",  // amber-500
  danger:    "#ef4444",  // red-500
  info:      "#06b6d4",  // cyan-500

  // ── Lines-of-code series ─────────────────────────────────────────────────
  locAdded:     "#10b981", // emerald-500  — completions accepted
  locDeleted:   "#ef4444", // red-500
  locSuggested: "#0ea5e9", // sky-500      (was blue-500 — distinct from locAdded)
  locAccepted:  "#6366f1", // indigo-500   (was violet-500 — distinct from sky)

  // ── IDE series ───────────────────────────────────────────────────────────
  vscode:       "#007acc",
  jetbrains:    "#fe315d",
  xcode:        "#147efb",
  neovim:       "#57a143",
  visualStudio: "#5c2d91",

  // ── PR / code-review actors ──────────────────────────────────────────────
  human:          "#3b82f6",  // blue-500
  copilot:        "#6366f1",  // indigo-500 (was violet-500; now unambiguous vs human)
  copilotReviewed: "#f59e0b", // amber-500 — Copilot-reviewed PRs

  // ── Copilot App surface ──────────────────────────────────────────────────
  /** Orange-500: distinct from all completion/agent/feature series. */
  copilotApp:        "#f97316", // orange-500
  /**
   * App "Deleted" series — orange-800 (not a tint of copilotApp) so it reads
   * as a separate series; always paired with a dashed stroke in charts.
   */
  copilotAppDeleted: "#c2410c", // orange-800
} as const;

export const FEATURE_LABELS: Record<string, string> = {
  code_completion: "Code Completions",
  inline_chat: "Inline Chat",
  // Legacy/alternate feature name for inline chat, distinct from `inline_chat`.
  // Kept here only so this broad display label renders correctly wherever raw
  // feature usage is shown; it is intentionally excluded from IS_COMPLETION_SQL/
  // isCompletionFeature() completion-acceptance classification — it is not part
  // of this codebase's explicit completion allowlist, so it must never be
  // added to that allowlist.
  chat_inline: "Inline Chat",
  chat_panel: "Chat Panel",
  chat_panel_ask_mode: "Chat – Ask",
  chat_panel_edit_mode: "Chat – Edit",
  chat_panel_plan_mode: "Chat – Plan",
  chat_panel_agent_mode: "Chat – Agent",
  chat_panel_custom_mode: "Chat – Custom",
  chat_panel_unknown_mode: "Chat – Unknown",
  agent_edit: "Agent Edit",
  copilot_app: "Copilot App",
};

export const CHAT_MODE_LABELS: Record<string, string> = {
  ask: "Ask",
  edit: "Edit",
  plan: "Plan",
  agent: "Agent",
  custom: "Custom",
  unknown: "Unknown",
};

export const CHAT_MODE_COLORS: Record<string, string> = {
  agent: CHART_COLORS.agent,
  ask: CHART_COLORS.ask,
  edit: CHART_COLORS.edit,
  plan: CHART_COLORS.plan,
  custom: CHART_COLORS.custom,
  unknown: CHART_COLORS.unknown,
};

export const CHAT_MODE_ICONS: Record<string, string> = {
  ask: "MessageSquare",
  edit: "Pencil",
  plan: "ClipboardList",
  agent: "Bot",
  custom: "Puzzle",
  unknown: "HelpCircle",
};

/**
 * Available date-range presets.
 *
 * 1-day and 2-day presets are intentionally omitted: the Copilot Usage Metrics
 * API delivers rolling-window products (e.g. 28-day PR counts, AI adoption
 * phase) that are meaningless at sub-week resolution, and several derived
 * metrics require at least 7 days of history to be interpretable.
 */
export const DATE_PRESETS = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "28 days", days: 28 },
  { label: "90 days", days: 90 },
  { label: "180 days", days: 180 },
  { label: "365 days", days: 365 },
] as const;

export const DEFAULT_DATE_RANGE_DAYS = 7;

/**
 * Days of inactivity after which a seat in the live `copilot_seats` snapshot is
 * treated as inactive.
 *
 * Shared by the SQL that computes the split (`getSeatStats`), the licensing
 * activity status (`deriveActivityStatus`) and the dashboard copy that explains
 * it, so the number a reader is shown can never drift from the number actually
 * used. Lives here because the dashboard is a client component and must not
 * import the SQLite-backed repositories.
 */
export const SEAT_ACTIVE_WINDOW_DAYS = 30;

/**
 * Data-quality caveat surfaced on the AI Credits page. The 2026-07-02 metrics
 * accuracy update began attributing AI-credit usage that was previously dropped
 * (org-less usage and users seen only via server-side telemetry). Already-reported
 * values are unchanged, so totals for periods before this date may undercount.
 * @see https://github.blog/changelog/2026-07-02-improved-accuracy-and-coverage-in-copilot-usage-metrics-reports/
 */
export const AI_CREDIT_COVERAGE_NOTE = {
  effectiveDate: "2026-07-02",
  message:
    "AI-credit coverage improved on 2026-07-02 (org-less and server-side-only usage now counted); totals for earlier periods may undercount.",
} as const;

/**
 * Data-quality caveat surfaced on the Copilot App Analytics page. GitHub's
 * July 28, 2026 usage-metrics expansion attributes Copilot App activity to
 * individual users and adds `copilot_app` to feature, model, and language
 * rollups. Date ranges predating this rollout will have no per-user App
 * attribution, so the page must not silently present that gap as zero usage.
 * @see https://github.blog/changelog/2026-07-28-github-copilot-app-usage-metrics-now-expand-across-report-rollups/
 */
export const COPILOT_APP_ROLLUP_NOTE = {
  effectiveDate: "2026-07-28",
  message:
    "User attribution and feature, model, language, and code rollups for Copilot App activity are available from 2026-07-28 onward.",
} as const;
