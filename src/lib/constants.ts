// Consistent chart color palette used across all dashboard pages
export const CHART_COLORS = {
  // Chat modes
  ask: "#3b82f6",       // blue-500
  edit: "#8b5cf6",      // violet-500
  plan: "#a855f7",      // purple-500
  agent: "#6366f1",     // indigo-500
  custom: "#ec4899",    // pink-500
  unknown: "#94a3b8",   // slate-400

  // Features
  completions: "#0ea5e9", // sky-500
  chat: "#8b5cf6",        // violet-500
  cli: "#10b981",         // emerald-500
  codeReview: "#f59e0b",  // amber-500

  // General
  primary: "#3b82f6",
  secondary: "#8b5cf6",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  info: "#06b6d4",

  // Lines of code
  locAdded: "#10b981",    // emerald-500
  locDeleted: "#ef4444",  // red-500
  locSuggested: "#3b82f6",// blue-500
  locAccepted: "#8b5cf6", // violet-500

  // IDE
  vscode: "#007acc",
  jetbrains: "#fe315d",
  xcode: "#147efb",
  neovim: "#57a143",
  visualStudio: "#5c2d91",

  // Copilot actors
  human: "#3b82f6",
  copilot: "#8b5cf6",
  copilotReviewed: "#f59e0b",  // amber-500 — Copilot-reviewed PRs
} as const;

export const FEATURE_LABELS: Record<string, string> = {
  code_completion: "Code Completions",
  inline_chat: "Inline Chat",
  chat_inline: "Inline Chat",
  chat_panel: "Chat Panel",
  chat_panel_ask_mode: "Chat – Ask",
  chat_panel_edit_mode: "Chat – Edit",
  chat_panel_plan_mode: "Chat – Plan",
  chat_panel_agent_mode: "Chat – Agent",
  chat_panel_custom_mode: "Chat – Custom",
  chat_panel_unknown_mode: "Chat – Unknown",
  agent_edit: "Agent Edit",
};

export const CHAT_MODE_LABELS: Record<string, string> = {
  ask: "Ask",
  edit: "Edit",
  plan: "Plan",
  agent: "Agent",
  custom: "Custom",
  unknown: "Unknown",
};

export const CHAT_MODE_ICONS: Record<string, string> = {
  ask: "MessageSquare",
  edit: "Pencil",
  plan: "ClipboardList",
  agent: "Bot",
  custom: "Puzzle",
  unknown: "HelpCircle",
};

export const DATE_PRESETS = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "28 days", days: 28 },
  { label: "90 days", days: 90 },
  { label: "180 days", days: 180 },
  { label: "365 days", days: 365 },
] as const;

export const DEFAULT_DATE_RANGE_DAYS = 90;
