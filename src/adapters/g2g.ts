/**
 * G2G adapter — hits sls.g2g.com/offer/search and normalizes listings
 * into NormalizedRow[].
 *
 * Tuned against real API responses (see scripts/debug-raw.ts output, 2026-05-20):
 *   - WoW gold: `unit_price` is ALREADY USD per 1 gold piece. Use directly.
 *   - Arc Raiders: titles are "All Platform > {Category} > {Item}" — parse to
 *     get the EZLoot category. Listings without that shape are skipped (junk).
 *   - WoW variant disambiguation: brand lgc_game_27816 covers Anniversary, SoD,
 *     Hardcore, and Classic Era. Parse the [region - variant] bracket in the
 *     server name to route each row to the right EZLoot game key.
 *   - EU region_id (ac3f85c1-7562-437e-b125-e89576b9a38e) is NEVER sent.
 */

import type { PricingAdapter, AdapterContext, NormalizedRow } from "./types.js";

// G2G service_id constants
const SVC_GOLD = "lgc_service_1";
const SVC_ITEMS = "0765978e-3fdf-48b4-bed3-184823aa439e";

interface G2GTarget {
  /**
   * Fallback EZLoot game key if no variant tag is found in the listing.
   * For gold, the bracket parser usually sets the actual key per row;
   * this default catches untagged listings.
   */
  defaultGame: string;
  category: string; // EZLoot category (overridden per-row for Arc Raiders)
  brandId: string;
  serviceId: string;
  kind: "wow_gold" | "arc_items";
}

const TARGETS: G2GTarget[] = [
  // WoW gold — single query per brand covers all sub-variants.
  // The bracket parser splits results into the right EZLoot game key.
  { defaultGame: "wow_classic_era", category: "gold", brandId: "lgc_game_27816", serviceId: SVC_GOLD, kind: "wow_gold" },
  { defaultGame: "wow_mop_classic", category: "gold", brandId: "lgc_game_29076", serviceId: SVC_GOLD, kind: "wow_gold" },
  { defaultGame: "wow_retail", category: "gold", brandId: "lgc_game_2299", serviceId: SVC_GOLD, kind: "wow_gold" },
  // Arc Raiders items — category set per-row from title parsing.
  { defaultGame: "arc_raiders", category: "items", brandId: "lgc_game_35181", serviceId: SVC_ITEMS, kind: "arc_items" },
];

interface G2GOffer {
  title?: string;
  unit_price?: number;
  available_qty?: number;
  total_stock?: number;
  min_qty?: number;
  unit_name?: string;
  listing_id?: string;
  offer_attributes?: Array<Record<string, unknown>>;
}

interface G2GSearchResponse {
  payload?: { results?: G2GOffer[] };
  results?: G2GOffer[];
}

function buildSearchUrl(
  serviceId: string,
  brandId: string,
  page: number,
  pageSize: number
): string {
  const u = new URL("https://sls.g2g.com/offer/search");
  u.searchParams.set("service_id", serviceId);
  u.searchParams.set("brand_id", brandId);
  // DO NOT set region_id — the EU UUID silently drops every non-EU listing.
  u.searchParams.set("language", "en");
  u.searchParams.set("country", "US");
  u.searchParams.set("currency", "USD");
  u.searchParams.set("sort", "lowest_price");
  u.searchParams.set("page_size", String(pageSize));
  u.searchParams.set("page", String(page));
  return u.toString();
}

const stableKey = (s: string) => s.replace(/\s+/g, " ").trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- WoW gold ----------------

/**
 * Determine the EZLoot game key(s) a WoW gold listing should be emitted under.
 *
 * Returns an ARRAY because some untagged listings should be emitted under
 * multiple keys. The brand `lgc_game_27816` covers four variants (Anniversary,
 * SoD, Hardcore, Classic Era proper) sharing the same brand_id. Sellers tag
 * some listings explicitly (`[US - Seasonal]` = SoD) but most just say `[US]`.
 *
 * Server names are globally unique across variants (Pagle is only on Anniversary,
 * Whitemane is only on Classic Era, Skull Rock only on Hardcore, etc.), so
 * cross-emitting an untagged row under multiple variant keys is safe — the
 * resolver still matches the right realm by name, and the frontend prevents
 * customers from selecting impossible variant+realm combos.
 *
 * Examples:
 *   "Lava Lash [US - Seasonal] - Horde"   → [wow_sod]
 *   "Pagle [US - Anniversary] - Alliance" → [wow_classic_era_anniversary]
 *   "Stitches [EU - Hardcore] - Horde"    → [wow_hardcore]
 *   "Pagle [US] - Alliance"               → [wow_classic_era_anniversary, wow_classic_era]
 *   "Auberdine [FR] - Horde"              → [wow_classic_era_anniversary, wow_classic_era]
 */
function wowVariantsFromTitle(title: string, fallback: string): string[] {
  const bracket = title.match(/\[([^\]]+)\]/);
  if (!bracket) return [fallback];
  const tag = bracket[1].toLowerCase();
  if (/anniversary/.test(tag)) return ["wow_classic_era_anniversary"];
  if (/seasonal|sod|season of discovery/.test(tag)) return ["wow_sod"];
  if (/hardcore/.test(tag)) return ["wow_hardcore"];
  // Region-only tag (no variant qualifier) — emit under both Anniversary
  // (the active customer-facing variant) and Classic Era proper. Server-name
  // uniqueness keeps this safe; the resolver will pick the right one.
  if (/^(us|eu|fr|de|cn|kr|ru|oce)( - .*)?$/.test(tag)) {
    return ["wow_classic_era_anniversary", "wow_classic_era"];
  }
  return [fallback];
}

/** Extract "{Server} - {Faction}" from a WoW gold title. */
function parseWowServerFaction(title: string): string | null {
  const factionMatch = title.match(/\b(alliance|horde)\b/i);
  if (!factionMatch) return null;
  const faction = factionMatch[1];
  // Title shape is consistently "Server [bracket] - Faction" or
  // "Server - Faction". Strip the bracket and faction suffix to get server.
  let server = title
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(new RegExp(`\\s*-?\\s*${faction}\\s*$`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
  if (!server) return null;
  // Title-case the faction for stable joins
  const factionTitle = faction.charAt(0).toUpperCase() + faction.slice(1).toLowerCase();
  return `${server} - ${factionTitle}`;
}

/**
 * Gold-price sanity gate. G2G's `unit_price` for gold is per-1-gold.
 * Anything above $1/piece is structurally bogus — drop before aggregating.
 * (The EZLoot outlier filter would catch this anyway; we drop early so the
 *  per-row MIN isn't dragged up.)
 */
function isPlausibleGoldUnitPrice(p: number | undefined): p is number {
  if (typeof p !== "number" || p <= 0) return false;
  if (p > 1) return false;
  return true;
}

function normalizeGoldOffers(offers: G2GOffer[], target: G2GTarget): NormalizedRow[] {
  // Group by (gameKey, itemKey). Untagged listings expand into multiple
  // gameKey buckets so the resolver can find them under any variant the
  // customer happens to be on.
  const grouped = new Map<string, { prices: number[]; stock: number; gameKey: string; itemKey: string }>();

  for (const offer of offers) {
    const title = offer.title?.trim() ?? "";
    if (!title) continue;
    if (!isPlausibleGoldUnitPrice(offer.unit_price)) continue;

    const itemKey = parseWowServerFaction(title);
    if (!itemKey) continue;

    const variants = wowVariantsFromTitle(title, target.defaultGame);
    for (const gameKey of variants) {
      const key = `${gameKey}|${itemKey}`;
      const bucket = grouped.get(key) ?? {
        prices: [],
        stock: 0,
        gameKey,
        itemKey,
      };
      bucket.prices.push(offer.unit_price);
      bucket.stock += offer.available_qty ?? offer.total_stock ?? 0;
      grouped.set(key, bucket);
    }
  }

  const rows: NormalizedRow[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.prices.length === 0) continue;
    bucket.prices.sort((a, b) => a - b);
    const min = bucket.prices[0];
    const max = bucket.prices[bucket.prices.length - 1];
    const avg = bucket.prices.reduce((a, b) => a + b, 0) / bucket.prices.length;
    rows.push({
      game: bucket.gameKey,
      category: "gold",
      item_key: bucket.itemKey,
      subkey: null,
      min_price_usd: min,
      avg_price_usd: avg,
      max_price_usd: max,
      // Gold qty = null: EZLoot's outlier filter only checks qty for stock
      // sanity on items. For gold we'd need millions to be "low stock" and
      // the field would just give false positives.
      qty: null,
    });
  }
  return rows;
}

// ---------------- Arc Raiders items ----------------

// Canonical EZLoot categories (from CLAUDE.md: blueprints / weapons /
// modification / materials / keys / recyclable). G2G uses near-matching
// strings in its titles — this map normalizes them.
const ARC_CATEGORY_MAP: Record<string, string> = {
  blueprints: "blueprints",
  blueprint: "blueprints",
  weapons: "weapons",
  weapon: "weapons",
  modification: "modification",
  modifications: "modification",
  mods: "modification",
  materials: "materials",
  material: "materials",
  keys: "keys",
  key: "keys",
  recyclable: "recyclable",
  recyclables: "recyclable",
};

// Per-category plausibility caps for Arc Raiders. Anything outside these is
// almost certainly a bundle listing where the seller stuffed a per-pack price
// into the per-unit field. Tuned against real prices observed on G2G as of
// 2026-05-20 (see scripts/test-g2g.ts output).
//
// Real ranges:
//   blueprints  $0.34 – ~$1.50   (cap from EZLoot's outlier filter: $0.01–$2)
//   weapons     $0.39 – ~$5      (Tempest IV is $0.60; rare weapons rarely > $10)
//   modification $0.20 – ~$3     (most $0.20–$0.50; rare slots maybe $5)
//   materials   $0.007 – ~$5     (Explosive Compound is $5; nothing else > $1)
//   recyclable  $0.14 – ~$2      (most under $0.20)
//   keys        $1.00 – ~$15     (Buried City JKV is $15; rare keys maybe $50)
//
// Cap = upper bound for legitimate per-unit prices. We pick conservative
// values that catch obvious bundles ($83K, $999) without rejecting rare
// premium items.
const ARC_CATEGORY_MAX_USD: Record<string, number> = {
  blueprints: 2,
  weapons: 100,
  modification: 50,
  materials: 50,
  recyclable: 50,
  keys: 100,
};
const ARC_CATEGORY_MIN_USD: Record<string, number> = {
  blueprints: 0.01,
  weapons: 0.05,
  modification: 0.05,
  materials: 0.001,
  recyclable: 0.01,
  keys: 0.1,
};

function isPlausibleArcPrice(category: string, price: number): boolean {
  const max = ARC_CATEGORY_MAX_USD[category];
  const min = ARC_CATEGORY_MIN_USD[category];
  if (max !== undefined && price > max) return false;
  if (min !== undefined && price < min) return false;
  return true;
}

/**
 * Parse an Arc Raiders G2G title into { category, itemName }.
 * Real titles are "All Platform > Materials > Plastic Parts" — anything
 * that doesn't fit that shape is a junk/bundle listing and returns null.
 */
function parseArcTitle(title: string): { category: string; itemName: string } | null {
  // Must have at least one ">" — junk listings rarely use this format.
  const parts = title.split(">").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // Last segment = item name. Second-to-last (or first) = category.
  const itemName = parts[parts.length - 1];
  // Category is typically parts[parts.length - 2] for "Platform > Category > Item"
  // or parts[0] for "Category > Item".
  const categoryRaw = parts.length >= 3
    ? parts[parts.length - 2]
    : parts[0];
  const category = ARC_CATEGORY_MAP[categoryRaw.toLowerCase()];
  if (!category) return null;
  if (!itemName) return null;
  return { category, itemName };
}

function normalizeArcOffers(offers: G2GOffer[], target: G2GTarget): NormalizedRow[] {
  // Group by (category, itemName)
  const grouped = new Map<string, { prices: number[]; stock: number; category: string; itemName: string }>();

  for (const offer of offers) {
    const title = offer.title?.trim() ?? "";
    if (!title) continue;
    const parsed = parseArcTitle(title);
    if (!parsed) continue;
    if (typeof offer.unit_price !== "number" || offer.unit_price <= 0) continue;
    // Drop bundle-listing prices before aggregation — otherwise a single
    // $85K outlier becomes the row's MIN if it's the only listing for that
    // item, and a customer would get quoted $85K.
    if (!isPlausibleArcPrice(parsed.category, offer.unit_price)) continue;

    const key = `${parsed.category}|${parsed.itemName.toLowerCase()}`;
    const bucket = grouped.get(key) ?? {
      prices: [],
      stock: 0,
      category: parsed.category,
      itemName: stableKey(parsed.itemName),
    };
    bucket.prices.push(offer.unit_price);
    bucket.stock += offer.available_qty ?? offer.total_stock ?? 0;
    grouped.set(key, bucket);
  }

  const rows: NormalizedRow[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.prices.length === 0) continue;
    bucket.prices.sort((a, b) => a - b);
    const min = bucket.prices[0];
    const max = bucket.prices[bucket.prices.length - 1];
    const avg = bucket.prices.reduce((a, b) => a + b, 0) / bucket.prices.length;
    rows.push({
      game: target.defaultGame,
      category: bucket.category,
      item_key: bucket.itemName,
      subkey: null,
      min_price_usd: min,
      avg_price_usd: avg,
      max_price_usd: max,
      qty: bucket.stock > 0 ? bucket.stock : null,
    });
  }
  return rows;
}

// ---------------- Fetch loop ----------------

async function fetchAllOffers(
  ctx: AdapterContext,
  target: G2GTarget
): Promise<G2GOffer[]> {
  const pageSize = 100;
  const maxPages = 20;
  const offers: G2GOffer[] = [];

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(1000 + Math.random() * 500);

    const url = buildSearchUrl(target.serviceId, target.brandId, page, pageSize);
    let resp: G2GSearchResponse;
    try {
      const res = await ctx.http.fetch(url);
      resp = (await res.json()) as G2GSearchResponse;
    } catch (err) {
      ctx.log.warn("G2G page fetch failed", { page, brandId: target.brandId, error: String(err) });
      break;
    }

    const results = resp?.payload?.results ?? resp?.results ?? [];
    if (results.length === 0) break;
    offers.push(...results);
    if (results.length < pageSize) break;
  }

  return offers;
}

const betweenTargetsSleep = () =>
  new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

export const g2gAdapter: PricingAdapter = {
  id: "g2g",
  name: "G2G (sls.g2g.com/offer/search)",

  coverage() {
    return TARGETS.map((t) => ({ game: t.defaultGame, category: t.category }));
  },

  async fetch(ctx) {
    const allRows: NormalizedRow[] = [];

    for (let i = 0; i < TARGETS.length; i++) {
      const target = TARGETS[i];
      if (i > 0) await betweenTargetsSleep();

      ctx.log.info("Scraping G2G target", {
        brandId: target.brandId,
        kind: target.kind,
      });

      try {
        const offers = await fetchAllOffers(ctx, target);
        const rows = target.kind === "wow_gold"
          ? normalizeGoldOffers(offers, target)
          : normalizeArcOffers(offers, target);

        ctx.log.info("G2G target done", {
          brandId: target.brandId,
          kind: target.kind,
          offers: offers.length,
          rows: rows.length,
        });

        allRows.push(...rows);
      } catch (err) {
        ctx.log.error("G2G target failed", {
          brandId: target.brandId,
          error: String(err),
        });
      }
    }

    return allRows;
  },
};
