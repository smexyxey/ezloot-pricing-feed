/**
 * Manual seed adapter — reads config/manual-seeds.yaml and emits rows.
 * Used for games/items where no marketplace has clean listings.
 * Prices set by the operator and version-controlled in the repo.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { PricingAdapter, AdapterContext, NormalizedRow } from "./types.js";

const SeedRow = z.object({
  game: z.string().min(1),
  category: z.string().min(1),
  item_key: z.string().min(1),
  subkey: z.string().optional(),
  /** USD per unit (per-1-gold for gold, per-item for items, etc.) */
  min_price_usd: z.number().positive(),
  notes: z.string().optional(),
});

type SeedRow = z.infer<typeof SeedRow>;

const SeedsFile = z.array(SeedRow);

function loadSeeds(seedsPath: string, log: AdapterContext["log"]): SeedRow[] {
  let raw: unknown;
  try {
    const contents = readFileSync(seedsPath, "utf-8");
    raw = yaml.load(contents);
  } catch (err) {
    log.warn("manual-seeds.yaml not found or unreadable — skipping", { path: seedsPath, error: String(err) });
    return [];
  }

  const result = SeedsFile.safeParse(raw);
  if (!result.success) {
    log.warn("manual-seeds.yaml parse errors — skipping invalid rows", {
      errors: result.error.flatten(),
    });
    // Return valid rows only
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[])
      .map((r) => SeedRow.safeParse(r))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: SeedRow }).data);
  }
  return result.data;
}

export const manualSeedAdapter: PricingAdapter = {
  id: "manual_seed",
  name: "Manual seed (config/manual-seeds.yaml)",

  coverage() {
    // Coverage is dynamic (depends on file contents) — return empty here.
    // The orchestrator will know from the returned rows.
    return [];
  },

  async fetch(ctx) {
    const seedsPath =
      (ctx.config.seeds_path as string | undefined) ??
      resolve(process.cwd(), "config", "manual-seeds.yaml");

    const seeds = loadSeeds(seedsPath, ctx.log);
    ctx.log.info("Manual seeds loaded", { count: seeds.length, path: seedsPath });

    return seeds.map(
      (s): NormalizedRow => ({
        game: s.game,
        category: s.category,
        item_key: s.item_key,
        subkey: s.subkey ?? null,
        min_price_usd: s.min_price_usd,
        avg_price_usd: null,
        max_price_usd: null,
        qty: null,
      })
    );
  },
};
