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
  kind: "wow_gold" | "arc_items" | "poe2_currency" | "osrs_gold";
}

const TARGETS: G2GTarget[] = [
  // WoW gold — single query per brand covers all sub-variants.
  // The bracket parser splits results into the right EZLoot game key.
  { defaultGame: "wow_classic_era", category: "gold", brandId: "lgc_game_27816", serviceId: SVC_GOLD, kind: "wow_gold" },
  { defaultGame: "wow_mop_classic", category: "gold", brandId: "lgc_game_29076", serviceId: SVC_GOLD, kind: "wow_gold" },
  { defaultGame: "wow_retail", category: "gold", brandId: "lgc_game_2299", serviceId: SVC_GOLD, kind: "wow_gold" },
  // Arc Raiders items — category set per-row from title parsing.
  { defaultGame: "arc_raiders", category: "items", brandId: "lgc_game_35181", serviceId: SVC_ITEMS, kind: "arc_items" },
  // PoE 2 currency — Softcore Current + Standard Softcore only.
  // Hardcore listings are dropped per v1 scope (the bag profile doesn't ship
  // Hardcore league pills yet). League and currency are parsed from the title:
  // "Fate of the Vaal Standard > Exalted Orb" → subkey="standard", item_key="Exalted Orb"
  { defaultGame: "poe2", category: "currency", brandId: "lgc_game_27013", serviceId: SVC_GOLD, kind: "poe2_currency" },
  // OSRS gold — single global economy, no servers. G2G returns 1 aggregated
  // row with the lowest seller price (unit_name="Mil" = USD per million GP).
  // We divide by 1M to get the per-1-GP value EZLoot stores.
  { defaultGame: "osrs", category: "gold", brandId: "lgc_game_19746", serviceId: SVC_GOLD, kind: "osrs_gold" },
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
// Real observed ranges:
//   blueprints  $0.34 – $1.50   (matches EZLoot's outlier filter cap of $2)
//   weapons     $0.25 – $5      (Tempest IV is $0.60; bundle outliers were $100)
//   modification $0.20 – $15    (Stable Stock II is $15; bundles were $85K)
//   materials   $0.007 – $5     (Explosive Compound is $5; bundles were $85K)
//   recyclable  $0.14 – $9      (Broken Flashlight is $9; bundles were $84K)
//   keys        $1.00 – $15     (Outskirts Bunker Key is $15; bundles were $100)
//
// Caps are tight (real max + a small buffer). Anything in this range is real;
// anything above is bundle-stuffed pricing. If a new legitimately-expensive
// item shows up, bump the cap.
const ARC_CATEGORY_MAX_USD: Record<string, number> = {
  blueprints: 2,
  weapons: 20,
  modification: 20,
  materials: 20,
  recyclable: 20,
  keys: 30,
};
const ARC_CATEGORY_MIN_USD: Record<string, number> = {
  blueprints: 0.01,
  weapons: 0.05,
  modification: 0.05,
  materials: 0.001,
  recyclable: 0.01,
  keys: 0.1,
};

/**
 * When an item has 3+ listings, skip the absolute cheapest and use the
 * 2nd-cheapest as the canonical min. Guards against fake-low listings where
 * sellers post $0.001 as bait with no real stock. With 1–2 listings we don't
 * have enough confidence to skip — use the raw min and trust the per-category
 * caps.
 */
function robustMin(sortedPrices: number[]): number {
  if (sortedPrices.length >= 3) return sortedPrices[1];
  return sortedPrices[0];
}

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
    const min = robustMin(bucket.prices);
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

// ---------------- PoE 2 currency ----------------

// Per-currency plausibility caps for PoE 2. Values reflect "USD per single unit"
// referenced against poe.ninja-equivalent in-game rates as of May 2026.
// Real ranges span ~4 orders of magnitude (Chaos ~$0.005 vs Mirror ~$16), so a
// flat cap doesn't work — each currency needs its own ceiling.
//
// Source: agent-research/GAME_RESEARCH_RESULTS.md §3 + cross-ref with poe.ninja
// and POECurrency.com listings. Caps set at ~5x reference price to absorb
// healthy league volatility without letting bundle-listing outliers through.
const POE2_CURRENCY_MAX_USD: Record<string, number> = {
  "mirror of kalandra": 30,
  "hinekora's lock": 30,
  "perfect jeweller's orb": 10,
  "fracturing orb": 5,
  "divine orb": 5,
  "orb of annulment": 2,
  "greater jeweller's orb": 2,
  "exalted orb": 0.5,
  "lesser jeweller's orb": 0.5,
  "chaos orb": 0.1,
  "regal orb": 0.1,
  "gemcutter's prism": 0.1,
  "orb of alchemy": 0.05,
  "vaal orb": 0.05,
  "orb of augmentation": 0.01,
  "orb of transmutation": 0.01,
  "armourer's scrap": 0.01,
  "blacksmith's whetstone": 0.01,
};
// Universal min — anything below this is fake-low bait or fractional bundle pricing.
const POE2_MIN_USD = 0.0001;

// Liquid Emotions (formerly Distilled Emotions) — 7 endgame Delirium variants.
// All trade at roughly the same value tier ($0.05 - $5 range depending on rarity).
// Bundled into the whitelist so the bag's "Other" path doesn't need to handle them.
const POE2_LIQUID_EMOTIONS = [
  "diluted liquid despair",
  "diluted liquid fear",
  "diluted liquid guilt",
  "diluted liquid isolation",
  "diluted liquid paranoia",
  "diluted liquid emptiness",
  "diluted liquid suffering",
  "liquid despair",
  "liquid fear",
  "liquid guilt",
  "liquid isolation",
  "liquid paranoia",
  "liquid emptiness",
  "liquid suffering",
];

/**
 * Strict whitelist: only accept prices for currencies that appear in the
 * canonical PoE 2 list. Sellers occasionally mislist PoE 1 currencies
 * ("Warlord's Exalted Orb", "Ancient Orb") under the PoE 2 brand_id;
 * these would otherwise pass our parser and end up quoted to customers.
 *
 * The bag profile's "Other" path routes unsupported requests to operator
 * review, so this whitelist matching the bag's currency dropdown is the
 * cleanest division of responsibility.
 */
function isPlausiblePoe2Price(currencyLower: string, price: number): boolean {
  if (price < POE2_MIN_USD) return false;
  const max = POE2_CURRENCY_MAX_USD[currencyLower];
  if (max !== undefined) return price <= max;
  if (POE2_LIQUID_EMOTIONS.includes(currencyLower)) return price <= 5;
  // Not an official PoE 2 currency — reject.
  return false;
}

/**
 * Parse a PoE 2 G2G title into { league, currency }.
 * Real titles follow "{LeagueName} > {Currency}":
 *   "Fate of the Vaal > Divine Orb"               → softcore current league
 *   "Fate of the Vaal Standard > Divine Orb"      → standard softcore
 *   "Fate of the Vaal Hardcore > Divine Orb"      → hardcore (dropped)
 *   "Fate of the Vaal Standard Hardcore > Divine Orb" → standard hardcore (dropped)
 *   "Early Access Standard > Exalted Orb"         → legacy mode (dropped — pricing
 *                                                   not meaningful for v1)
 *
 * Returns null for:
 *   - titles without ">" (bundle/custom listings)
 *   - hardcore variants (per v1 scope, EZLoot bag only ships Softcore pills)
 *   - legacy "Early Access" leagues (Q1 2025 economy, irrelevant now)
 *
 * Subkey output:
 *   "current"  → current Softcore League
 *   "standard" → Standard Softcore
 */
function parsePoe2Title(title: string): { subkey: string; currency: string } | null {
  const parts = title.split(">").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const currency = parts[parts.length - 1];
  const league = parts.slice(0, parts.length - 1).join(" > ").trim();
  if (!currency || !league) return null;

  const leagueLower = league.toLowerCase();
  // Hardcore variants — drop per v1 scope. Catches both "Hardcore" alone
  // and "Standard Hardcore". MUST check before the "standard" branch.
  if (/\bhardcore\b/.test(leagueLower)) return null;
  // Legacy Early Access leagues — drop. Pricing reflects pre-1.0 economy
  // and the player base has migrated forward.
  if (/early access/.test(leagueLower)) return null;

  const subkey = /\bstandard\b/.test(leagueLower) ? "standard" : "current";
  return { subkey, currency };
}

function normalizePoe2Offers(offers: G2GOffer[], target: G2GTarget): NormalizedRow[] {
  // Group by (subkey, normalized currency)
  const grouped = new Map<string, { prices: number[]; stock: number; subkey: string; currency: string }>();

  for (const offer of offers) {
    const title = offer.title?.trim() ?? "";
    if (!title) continue;
    const parsed = parsePoe2Title(title);
    if (!parsed) continue;
    if (typeof offer.unit_price !== "number" || offer.unit_price <= 0) continue;

    const currencyLower = parsed.currency.toLowerCase();
    if (!isPlausiblePoe2Price(currencyLower, offer.unit_price)) continue;

    const key = `${parsed.subkey}|${currencyLower}`;
    const bucket = grouped.get(key) ?? {
      prices: [],
      stock: 0,
      subkey: parsed.subkey,
      currency: stableKey(parsed.currency),
    };
    bucket.prices.push(offer.unit_price);
    bucket.stock += offer.available_qty ?? offer.total_stock ?? 0;
    grouped.set(key, bucket);
  }

  const rows: NormalizedRow[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.prices.length === 0) continue;
    bucket.prices.sort((a, b) => a - b);
    const min = robustMin(bucket.prices);
    const max = bucket.prices[bucket.prices.length - 1];
    const avg = bucket.prices.reduce((a, b) => a + b, 0) / bucket.prices.length;
    rows.push({
      game: target.defaultGame,
      category: target.category,
      item_key: bucket.currency,
      subkey: bucket.subkey,
      min_price_usd: min,
      avg_price_usd: avg,
      max_price_usd: max,
      qty: bucket.stock > 0 ? bucket.stock : null,
    });
  }
  return rows;
}

// ---------------- OSRS gold ----------------

// Per-million-GP plausibility caps. Real OSRS gold market: $0.13-$0.50/M
// depending on platform + supply (botted floods bring it down, content
// drops push it up). Anything outside is bundle stuffing or fake bait.
const OSRS_MIN_USD_PER_MIL = 0.05;
const OSRS_MAX_USD_PER_MIL = 1.0;

/**
 * OSRS has a single global economy — sellers don't list per server / faction.
 * G2G's sls.g2g.com/offer/search returns a small set of aggregated rows (often
 * just 1) with unit_name="Mil" (millions of GP). The per-1-GP value EZLoot
 * stores is unit_price / 1,000,000.
 *
 * No title parsing needed — every legit OSRS row gets normalized to the
 * canonical item_key "OSRS Gold" that the bag profile + SYSTEM_PROMPT use.
 */
function normalizeOsrsOffers(offers: G2GOffer[], target: G2GTarget): NormalizedRow[] {
  const prices: number[] = [];
  let totalStock = 0;

  for (const offer of offers) {
    if (typeof offer.unit_price !== "number" || offer.unit_price <= 0) continue;
    // unit_name should be "Mil" — bail if a future seller starts using a
    // different denomination so we don't silently mis-scale.
    if (offer.unit_name && offer.unit_name.toLowerCase() !== "mil") {
      continue;
    }
    if (offer.unit_price < OSRS_MIN_USD_PER_MIL) continue;
    if (offer.unit_price > OSRS_MAX_USD_PER_MIL) continue;
    prices.push(offer.unit_price);
    totalStock += offer.available_qty ?? offer.total_stock ?? 0;
  }

  if (prices.length === 0) return [];

  prices.sort((a, b) => a - b);
  const minPerMil = robustMin(prices);
  const maxPerMil = prices[prices.length - 1];
  const avgPerMil = prices.reduce((a, b) => a + b, 0) / prices.length;

  // Convert all to per-single-GP (EZLoot's canonical storage unit).
  const minPerGp = minPerMil / 1_000_000;
  const maxPerGp = maxPerMil / 1_000_000;
  const avgPerGp = avgPerMil / 1_000_000;

  return [
    {
      game: target.defaultGame,
      category: "gold",
      item_key: "OSRS Gold",
      subkey: null,
      min_price_usd: minPerGp,
      avg_price_usd: avgPerGp,
      max_price_usd: maxPerGp,
      // OSRS qty is in millions on G2G; convert to per-GP-equivalent for
      // consistency with WoW (which uses null). Null is fine here — gold
      // category never triggers the low-stock filter anyway.
      qty: null,
    },
  ];
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
        let rows: NormalizedRow[];
        switch (target.kind) {
          case "wow_gold":
            rows = normalizeGoldOffers(offers, target);
            break;
          case "arc_items":
            rows = normalizeArcOffers(offers, target);
            break;
          case "poe2_currency":
            rows = normalizePoe2Offers(offers, target);
            break;
          case "osrs_gold":
            rows = normalizeOsrsOffers(offers, target);
            break;
        }

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
