import type { CSVColumn } from "./csv";

export interface UserExportRow {
  login: string;
  activeDays: number;
  locAdded: number;
  interactions: number;
  aiCreditsUsed: number;
  acceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReviewActive: boolean;
  usedCodeReviewPassive: boolean;
  usedCodingAgent: boolean;
}

export function formatUserExportAiCredits(
  row: Pick<UserExportRow, "aiCreditsUsed">,
): string {
  const value = Number.isFinite(row.aiCreditsUsed) ? row.aiCreditsUsed : 0;
  return value.toFixed(2);
}

export function formatUserExportAcceptanceRate(
  row: Pick<UserExportRow, "acceptanceRate">,
): string {
  const value = Number.isFinite(row.acceptanceRate) ? row.acceptanceRate : 0;
  return `${value.toFixed(1)}%`;
}

export function formatUserExportFeatures(row: UserExportRow): string {
  const features: string[] = [];

  if (row.usedAgent) features.push("Agent");
  if (row.usedCodingAgent) features.push("Coding Agent");
  if (row.usedChat) features.push("Chat");
  if (row.usedCli) features.push("CLI");
  if (row.usedCodeReviewActive) features.push("Code Review (Active)");
  else if (row.usedCodeReviewPassive) features.push("Code Review (Passive)");

  return features.join(", ");
}

export const userExportColumns: CSVColumn[] = [
  { key: "login", label: "User" },
  { key: "activeDays", label: "Active Days" },
  { key: "locAdded", label: "LoC Added" },
  { key: "interactions", label: "Interactions" },
  {
    key: "aiCreditsUsed",
    label: "AI Credits Used",
    format: formatUserExportAiCredits,
  },
  {
    key: "acceptanceRate",
    label: "Acceptance %",
    format: formatUserExportAcceptanceRate,
  },
  {
    key: "features",
    label: "Features",
    format: formatUserExportFeatures,
  },
];
