import type { NormalizedRow } from "./adapters/types.js";

// Thresholds ported from lib/pricing-intel-store.ts in the EZLoot repo.
// Keep in sync when those are updated.

const MIN_QTY = 5;
const OUTLIER_RATIO = 0.1;
const GOLD_MAX_USD_PER_PIECE = 1;
const BLUEPRINT_MAX_USD_PER_UNIT = 2;
const BLUEPRINT_MIN_USD_PER_UNIT = 0.01;
const BLUEPRINT_BUNDLE_TITLE_RE =
  /\b(ALL BLUEPRINTS?|EVERY BLUEPRINT|\d{1,3}\s*BPs?\b|Unlock (Every|All)|Max (Progress|Workbench))\b/i;

type DropReason = "low_qty" | "outlier" | "no_price" | "bundle_title";

function dropReason(row: NormalizedRow): DropReason | null {
  if (row.min_price_usd == null || row.min_price_usd <= 0) return "no_price";

  if (row.qty != null && row.qty < MIN_QTY) return "low_qty";

  if (row.category === "gold" && row.min_price_usd > GOLD_MAX_USD_PER_PIECE) {
    return "outlier";
  }

  if (row.category === "blueprints") {
    if (row.min_price_usd > BLUEPRINT_MAX_USD_PER_UNIT) return "outlier";
    if (row.min_price_usd < BLUEPRINT_MIN_USD_PER_UNIT) return "outlier";
    if (BLUEPRINT_BUNDLE_TITLE_RE.test(row.item_key)) return "bundle_title";
  }

  if (
    row.avg_price_usd != null &&
    row.avg_price_usd > 0 &&
    row.min_price_usd < OUTLIER_RATIO * row.avg_price_usd
  ) {
    return "outlier";
  }

  return null;
}

export interface FilterSummary {
  accepted: number;
  dropped_no_price: number;
  dropped_low_qty: number;
  dropped_outlier: number;
}

export function filterOutliers(rows: NormalizedRow[]): {
  rows: NormalizedRow[];
  summary: FilterSummary;
} {
  const summary: FilterSummary = {
    accepted: 0,
    dropped_no_price: 0,
    dropped_low_qty: 0,
    dropped_outlier: 0,
  };
  const accepted: NormalizedRow[] = [];

  for (const row of rows) {
    const reason = dropReason(row);
    if (reason === null) {
      accepted.push(row);
      summary.accepted++;
    } else if (reason === "no_price") {
      summary.dropped_no_price++;
    } else if (reason === "low_qty") {
      summary.dropped_low_qty++;
    } else {
      summary.dropped_outlier++;
    }
  }

  return { rows: accepted, summary };
}
