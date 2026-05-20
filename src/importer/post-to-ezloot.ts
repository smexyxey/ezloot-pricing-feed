/**
 * Post normalized rows to EZLoot's pricing-intel import endpoint.
 *
 * The endpoint currently uses cookie-based owner auth (requireRole("owner")).
 * The new service sends `Authorization: Bearer <EZLOOT_IMPORT_TOKEN>`.
 * The main EZLoot session needs to add Bearer token support to the import
 * route (app/api/admin/pricing-intel/import/route.ts) before this works
 * in production. Until then, test with a local override URL.
 *
 * Request body: { rows: PricingIntelRow[] }
 * where PricingIntelRow matches the shape in lib/pricing-intel-store.ts.
 */

import type { NormalizedRow } from "../adapters/types.js";
import type { Logger } from "../adapters/types.js";

export interface ImportResult {
  ok: boolean;
  inserted?: number;
  skipped?: number;
  error?: string;
}

/** Shape the import endpoint expects in pre-flattened row mode. */
interface PricingIntelRow {
  game: string;
  category: string;
  item_key: string;
  subkey: string; // empty string, not null
  min_price_usd: number | null;
  avg_price_usd: number | null;
  max_price_usd: number | null;
  qty: number | null;
  source: string;
  raw: Record<string, unknown>;
}

function toImportRow(row: NormalizedRow, source: string): PricingIntelRow {
  return {
    game: row.game,
    category: row.category,
    item_key: row.item_key,
    subkey: row.subkey ?? "",
    min_price_usd: row.min_price_usd,
    avg_price_usd: row.avg_price_usd ?? null,
    max_price_usd: row.max_price_usd ?? null,
    qty: row.qty ?? null,
    source,
    raw: row.source_url ? { source_url: row.source_url } : {},
  };
}

const CHUNK_SIZE = 500;

export async function postToEzloot(opts: {
  rows: NormalizedRow[];
  source: string;
  importUrl: string;
  token: string;
  log: Logger;
}): Promise<ImportResult> {
  const { rows, source, importUrl, token, log } = opts;

  if (rows.length === 0) {
    log.info("postToEzloot: no rows to send");
    return { ok: true, inserted: 0, skipped: 0 };
  }

  const importRows = rows.map((r) => toImportRow(r, source));

  let totalInserted = 0;
  let totalSkipped = 0;

  for (let i = 0; i < importRows.length; i += CHUNK_SIZE) {
    const chunk = importRows.slice(i, i + CHUNK_SIZE);
    const body = JSON.stringify({ rows: chunk });

    let res: Response;
    try {
      res = await fetch(importUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
      });
    } catch (err) {
      log.error("postToEzloot fetch error", { error: String(err) });
      return { ok: false, error: String(err) };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.error("postToEzloot non-ok response", { status: res.status, body: text });
      // On 4xx (malformed batch) we don't retry — log and return
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, error: `HTTP ${res.status}: ${text}` };
      }
      // On 5xx, surface the error — the caller (orchestrator) handles retry
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }

    let json: { ok?: boolean; summary?: { inserted?: number }; inserted?: number; skipped?: number } = {};
    try {
      json = await res.json() as typeof json;
    } catch {
      // Non-JSON success response is ok
    }

    const inserted = json?.summary?.inserted ?? json?.inserted ?? chunk.length;
    const skipped = json?.skipped ?? 0;
    totalInserted += inserted;
    totalSkipped += skipped;

    log.info("postToEzloot chunk sent", {
      chunk: Math.floor(i / CHUNK_SIZE) + 1,
      sent: chunk.length,
      inserted,
      skipped,
    });
  }

  return { ok: true, inserted: totalInserted, skipped: totalSkipped };
}
