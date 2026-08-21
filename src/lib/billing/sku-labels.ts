/**
 * Friendly display labels for GitHub billing SKU strings.
 *
 * The billing usage report identifies *what* was charged through its `sku`
 * column — Copilot Business vs. Enterprise seats, and which surface burned AI
 * credits (cloud agent, code review, code quality, and so on). GitHub does not
 * publish a stable, exhaustive list of these strings, and they change as new
 * agentic surfaces ship.
 *
 * So nothing here is authoritative and nothing numeric depends on it. Labels
 * are cosmetic: an unrecognised SKU renders its own name, humanised, with its
 * figures completely intact. That is deliberate — a display map that silently
 * dropped or misfiled an unknown surface would be far worse than one that
 * shows a raw string.
 */

/** Which side of the bill a SKU sits on. */
export type SkuKind = "seat" | "consumption";

/**
 * Normalize a SKU for matching: lowercase, and collapse the separators GitHub
 * has used interchangeably (`_`, `-`, spaces) to a single underscore.
 */
function normalizeSku(sku: string): string {
  return sku
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

/** Exact-match labels, checked first. Keys are normalized SKU strings. */
const EXACT_LABELS: Record<string, string> = {
  copilot_business: "Copilot Business",
  copilot_for_business: "Copilot Business",
  copilot_business_seat: "Copilot Business",
  copilot_enterprise: "Copilot Enterprise",
  copilot_enterprise_seat: "Copilot Enterprise",
  copilot_pro: "Copilot Pro",
  copilot_pro_plus: "Copilot Pro+",
  copilot_ai_credit: "AI credits",
  copilot_ai_credits: "AI credits",
  copilot_premium_request: "Premium requests",
  copilot_premium_requests: "Premium requests",
};

/**
 * Substring patterns, checked in order when no exact match applies. Order
 * matters: the more specific surface must be tested before the generic plan
 * fallbacks, or `copilot_enterprise_code_review` would be labelled as a seat
 * plan rather than as the code-review surface.
 */
const PATTERN_LABELS: { match: string; label: string }[] = [
  { match: "coding_agent", label: "Cloud agent" },
  { match: "cloud_agent", label: "Cloud agent" },
  { match: "padawan", label: "Cloud agent" },
  { match: "code_review", label: "Code review" },
  { match: "code_quality", label: "Code quality" },
  { match: "spark", label: "Spark" },
  { match: "agent_task", label: "Agent tasks" },
  { match: "cli", label: "Copilot CLI" },
  { match: "chat", label: "Copilot Chat" },
  { match: "extension", label: "Copilot Extensions" },
  { match: "knowledge_base", label: "Knowledge bases" },
  { match: "enterprise", label: "Copilot Enterprise" },
  { match: "business", label: "Copilot Business" },
];

/**
 * Humanise an unrecognised SKU rather than hiding it: strip a leading
 * `copilot_`, split on underscores, and capitalise the first word. The result
 * is still recognisably the original string, so an operator can match it back
 * to their billing report.
 */
function humanizeSku(sku: string): string {
  const trimmed = sku.trim();
  if (!trimmed) return "Unspecified";
  const words = normalizeSku(trimmed).replace(/^copilot_/, "").split("_").filter(Boolean);
  if (words.length === 0) return trimmed;
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Display label for a billing SKU. Never throws, never returns an empty
 * string, and never loses the caller's SKU: unknown values are humanised, not
 * bucketed into "Other".
 */
export function skuLabel(sku: string | null | undefined): string {
  if (!sku || !sku.trim()) return "Unspecified";
  const key = normalizeSku(sku);

  const exact = EXACT_LABELS[key];
  if (exact) return exact;

  for (const { match, label } of PATTERN_LABELS) {
    if (key.includes(match)) return label;
  }

  return humanizeSku(sku);
}

/**
 * Whether a SKU is a seat licence or a consumption charge.
 *
 * This is a *hint* only, used to order the display. Every figure in the
 * dashboard classifies by `unit_type` instead, because that is the field
 * GitHub's reporting documentation says to filter on and the only one that
 * keeps credits, requests and token units from being summed together.
 */
export function skuKind(sku: string | null | undefined): SkuKind {
  const key = normalizeSku(sku ?? "");
  if (!key) return "consumption";
  if (key.includes("credit") || key.includes("request") || key.includes("token")) {
    return "consumption";
  }
  if (key.includes("seat")) return "seat";
  if (EXACT_LABELS[key]?.startsWith("Copilot ")) return "seat";
  return "consumption";
}
