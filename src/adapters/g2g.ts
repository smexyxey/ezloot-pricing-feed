/**
 * G2G adapter — hits sls.g2g.com/offer/search and normalizes listings
 * into NormalizedRow[].
 *
 * Ported from lib/g2g-scrape.ts in the EZLoot repo (disabled per task #179).
 * Key fixes applied vs. the original:
 *   - EU region_id (ac3f85c1-7562-437e-b125-e89576b9a38e) is NEVER sent.
 *   - Gold rows normalize to USD per 1 gold piece (unit_price / available_qty).
 *   - EZLoot-canonical game keys (wow_classic_era_anniversary etc.) used throughout.
 */

import type { PricingAdapter, AdapterContext, NormalizedRow } from "./types.js";

// G2G brand_id → EZLoot canonical game key.
// A single brand_id can cover multiple EZLoot variants (e.g. lgc_game_27816
// covers anniversary, sod, hardcore, classic_era). We use the most-trafficked
// variant as the primary key and rely on the server-faction-resolver in EZLoot
// to disambiguate. v2: cross-reference wow_servers API to split by variant.
const BRAND_TO_GAME: Record<string, string> = {
  lgc_game_35181: "arc_raiders",
  lgc_game_27816: "wow_classic_era_anniversary",
  lgc_game_29076: "wow_mop_classic",
  lgc_game_2299: "wow_retail",
};

// G2G service_id constants
const SVC_GOLD = "lgc_service_1";
const SVC_ITEMS = "0765978e-3fdf-48b4-bed3-184823aa439e";

interface G2GTarget {
  game: string;
  category: string; // EZLoot category
  brandId: string;
  serviceId: string;
  isGold: boolean;
}

const TARGETS: G2GTarget[] = [
  // WoW gold (all Classic-era variants share lgc_game_27816)
  { game: "wow_classic_era_anniversary", category: "gold", brandId: "lgc_game_27816", serviceId: SVC_GOLD, isGold: true },
  { game: "wow_mop_classic", category: "gold", brandId: "lgc_game_29076", serviceId: SVC_GOLD, isGold: true },
  { game: "wow_retail", category: "gold", brandId: "lgc_game_2299", serviceId: SVC_GOLD, isGold: true },
  // Arc Raiders items + blueprints
  { game: "arc_raiders", category: "items", brandId: "lgc_game_35181", serviceId: SVC_ITEMS, isGold: false },
];

interface G2GOffer {
  title?: string;
  offer_attributes?: Array<{
    collection_id?: string;
    collection_name?: string;
    dataset_id?: string;
    dataset_value?: string;
    label?: string;
  }>;
  unit_price?: number;
  total_stock?: number;
  available_qty?: number;
  listing_id?: string;
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
  // DO NOT set region_id — the EU UUID (ac3f85c1-7562-437e-b125-e89576b9a38e)
  // silently drops every non-EU listing. Omitting region_id returns all regions.
  u.searchParams.set("language", "en");
  u.searchParams.set("country", "US");
  u.searchParams.set("currency", "USD");
  u.searchParams.set("sort", "lowest_price");
  u.searchParams.set("page_size", String(pageSize));
  u.searchParams.set("page", String(page));
  return u.toString();
}

/** Pull an offer attribute value by label (case-insensitive). */
function attr(offer: G2GOffer, label: string): string | null {
  const found = offer.offer_attributes?.find(
    (a) => a.label?.toLowerCase() === label.toLowerCase()
  );
  return found?.dataset_value ?? null;
}

/**
 * Try to extract server + faction from a WoW gold listing.
 * G2G offer_attributes often have structured "Server" and "Faction" fields.
 * Falls back to title parsing.
 *
 * Returns null when we can't extract both confidently.
 */
function extractGoldKey(offer: G2GOffer): { itemKey: string; faction: string } | null {
  // Prefer structured attributes
  const server = attr(offer, "server") ?? attr(offer, "realm");
  const faction = attr(offer, "faction") ?? attr(offer, "side");

  if (server && faction) {
    return {
      itemKey: `${server.trim()} - ${faction.trim()}`,
      faction: faction.trim(),
    };
  }

  // Fall back to title parsing
  const title = offer.title?.trim() ?? "";
  if (!title) return null;

  const factionMatch = title.match(/\b(alliance|horde)\b/i);
  if (!factionMatch) return null;

  const detectedFaction = factionMatch[1];
  // Strip faction name + common noise words to get server name
  let serverName = title
    .replace(new RegExp(`\\b${detectedFaction}\\b`, "i"), "")
    .replace(/\bgold\b|\bwow\b|\bcoins?\b|\binstant\b|\bdelivery\b|\bfast\b/gi, "")
    .replace(/[|,\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!serverName) return null;

  return {
    itemKey: `${serverName} - ${detectedFaction}`,
    faction: detectedFaction,
  };
}

/**
 * Per-gold-piece price from a G2G offer.
 *
 * G2G gold listings price in USD for a block of gold. The `unit_price` field
 * is the price for the listed quantity (`available_qty` gold pieces).
 * Dividing gives USD per 1 gold piece — the unit EZLoot stores.
 *
 * TODO: Verify against real API responses. If G2G's unit_price is already
 * per-1K-gold, adjust the divisor. The outlier filter (cap $1/piece) catches
 * wildly wrong values, so bad conversions surface quickly.
 */
function goldPricePerPiece(offer: G2GOffer): number | null {
  const price = offer.unit_price;
  const qty = offer.available_qty ?? offer.total_stock;
  if (!price || price <= 0) return null;
  if (!qty || qty <= 0) return null;
  return price / qty;
}

/** Stable item_key — collapse whitespace, trim. */
const stableKey = (s: string) => s.replace(/\s+/g, " ").trim();

async function fetchAllOffers(
  ctx: AdapterContext,
  target: G2GTarget
): Promise<G2GOffer[]> {
  const pageSize = 100;
  const maxPages = 15;
  const offers: G2GOffer[] = [];

  // Polite rate-limit: 1 req/sec with jitter between pages.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(1000 + Math.random() * 500);

    const url = buildSearchUrl(target.serviceId, target.brandId, page, pageSize);
    ctx.log.debug("Fetching G2G page", { page, game: target.game, category: target.category });

    let resp: G2GSearchResponse;
    try {
      const res = await ctx.http.fetch(url);
      resp = (await res.json()) as G2GSearchResponse;
    } catch (err) {
      ctx.log.warn("G2G page fetch failed", {
        page,
        game: target.game,
        error: String(err),
      });
      break;
    }

    const results = resp?.payload?.results ?? resp?.results ?? [];
    if (results.length === 0) break;
    offers.push(...results);
    if (results.length < pageSize) break;
  }

  return offers;
}

function normalizeGoldOffers(offers: G2GOffer[], target: G2GTarget): NormalizedRow[] {
  // Group by extracted server-faction key
  const grouped = new Map<string, number[]>();

  for (const offer of offers) {
    const extracted = extractGoldKey(offer);
    if (!extracted) continue;

    const key = stableKey(extracted.itemKey);
    const pricePerPiece = goldPricePerPiece(offer);
    if (pricePerPiece == null || pricePerPiece <= 0) continue;

    const arr = grouped.get(key) ?? [];
    arr.push(pricePerPiece);
    grouped.set(key, arr);
  }

  const rows: NormalizedRow[] = [];
  for (const [itemKey, prices] of grouped) {
    if (prices.length === 0) continue;
    prices.sort((a, b) => a - b);
    const min = prices[0];
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const max = prices[prices.length - 1];
    rows.push({
      game: target.game,
      category: target.category,
      item_key: itemKey,
      subkey: null,
      min_price_usd: min,
      avg_price_usd: avg,
      max_price_usd: max,
      qty: prices.length,
    });
  }
  return rows;
}

function normalizeItemOffers(offers: G2GOffer[], target: G2GTarget): NormalizedRow[] {
  const grouped = new Map<string, G2GOffer[]>();

  for (const offer of offers) {
    const title = stableKey(offer.title ?? "");
    if (!title) continue;
    const arr = grouped.get(title) ?? [];
    arr.push(offer);
    grouped.set(title, arr);
  }

  const rows: NormalizedRow[] = [];
  for (const [title, group] of grouped) {
    const prices = group
      .map((o) => o.unit_price)
      .filter((p): p is number => typeof p === "number" && p > 0);
    if (prices.length === 0) continue;
    prices.sort((a, b) => a - b);
    const min = prices[0];
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const max = prices[prices.length - 1];
    const qty = group.reduce(
      (acc, o) => acc + (o.available_qty ?? o.total_stock ?? 0),
      0
    ) || null;
    rows.push({
      game: target.game,
      category: target.category,
      item_key: title,
      subkey: null,
      min_price_usd: min,
      avg_price_usd: avg,
      max_price_usd: max,
      qty,
    });
  }
  return rows;
}

// Inter-target sleep to be polite to G2G. Random between 2–4 seconds.
const betweenTargetsSleep = () =>
  new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

export const g2gAdapter: PricingAdapter = {
  id: "g2g",
  name: "G2G (sls.g2g.com/offer/search)",

  coverage() {
    return TARGETS.map((t) => ({ game: t.game, category: t.category }));
  },

  async fetch(ctx) {
    const enabledTargets = TARGETS.filter((t) => {
      const key = `${t.game}.${t.category}`;
      const disabled = ctx.config.disabled_targets as string[] | undefined;
      return !disabled?.includes(key);
    });

    const allRows: NormalizedRow[] = [];

    for (let i = 0; i < enabledTargets.length; i++) {
      const target = enabledTargets[i];
      if (i > 0) await betweenTargetsSleep();

      ctx.log.info("Scraping G2G target", {
        game: target.game,
        category: target.category,
      });

      try {
        const offers = await fetchAllOffers(ctx, target);
        const rows = target.isGold
          ? normalizeGoldOffers(offers, target)
          : normalizeItemOffers(offers, target);

        ctx.log.info("G2G target done", {
          game: target.game,
          category: target.category,
          offers: offers.length,
          rows: rows.length,
        });

        allRows.push(...rows);
      } catch (err) {
        ctx.log.error("G2G target failed", {
          game: target.game,
          category: target.category,
          error: String(err),
        });
        // Non-fatal — continue other targets
      }
    }

    return allRows;
  },
};
