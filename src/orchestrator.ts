/**
 * Orchestrator: loads enabled adapters, runs them in parallel, filters
 * outliers, and POSTs normalized rows to the EZLoot import endpoint.
 */

import { filterOutliers, type FilterSummary } from "./outlier-filter.js";
import { postToEzloot, type ImportResult } from "./importer/post-to-ezloot.js";
import { createHttpClient } from "./http/client.js";
import { g2gAdapter } from "./adapters/g2g.js";
import { manualSeedAdapter } from "./adapters/manual-seed.js";
import { adapterLogger, logger } from "./logger.js";
import { getConfig } from "./config.js";
import type { PricingAdapter, NormalizedRow } from "./adapters/types.js";

const ADAPTERS: PricingAdapter[] = [g2gAdapter, manualSeedAdapter];

export interface AdapterRunResult {
  adapterId: string;
  status: "ok" | "error";
  rowsFetched: number;
  rowsAccepted: number;
  filterSummary: FilterSummary;
  importResult: ImportResult | null;
  error?: string;
  durationMs: number;
}

export interface OrchestratorResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  adapters: AdapterRunResult[];
  totalInserted: number;
}

/** Singleton state for /health endpoint. */
export const runState = {
  lastRun: null as OrchestratorResult | null,
  running: false,
};

export async function runAll(): Promise<OrchestratorResult> {
  if (runState.running) {
    logger.warn("runAll: already running — skipping");
    throw new Error("Run already in progress");
  }

  runState.running = true;
  const config = getConfig();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  logger.info({ adapters: ADAPTERS.map((a) => a.id) }, "Orchestrator starting");

  const adapterResults: AdapterRunResult[] = await Promise.all(
    ADAPTERS.map(async (adapter) => {
      const adapterStart = Date.now();
      const log = adapterLogger(adapter.id);

      const http = createHttpClient({ maxRetries: 3, baseDelayMs: 1000 });
      // Per-adapter config is a no-op in v1 — extend via adapters.yaml later
      const adapterConfig: Record<string, unknown> = {};

      let rows: NormalizedRow[] = [];
      try {
        rows = await adapter.fetch({ http, config: adapterConfig, log });
      } catch (err) {
        const durationMs = Date.now() - adapterStart;
        log.error("Adapter fetch failed", { error: String(err) });
        return {
          adapterId: adapter.id,
          status: "error" as const,
          rowsFetched: 0,
          rowsAccepted: 0,
          filterSummary: { accepted: 0, dropped_no_price: 0, dropped_low_qty: 0, dropped_outlier: 0 },
          importResult: null,
          error: String(err),
          durationMs,
        };
      }

      const { rows: accepted, summary: filterSummary } = filterOutliers(rows);
      log.info("Outlier filter", { fetched: rows.length, ...filterSummary });

      let importResult: ImportResult | null = null;
      if (accepted.length > 0) {
        importResult = await postToEzloot({
          rows: accepted,
          source: adapter.id,
          importUrl: config.EZLOOT_IMPORT_URL,
          token: config.EZLOOT_IMPORT_TOKEN,
          log,
        });
        log.info("Import done", { ...importResult });
      } else {
        log.info("No rows to import after filtering");
      }

      return {
        adapterId: adapter.id,
        status: "ok" as const,
        rowsFetched: rows.length,
        rowsAccepted: accepted.length,
        filterSummary,
        importResult,
        durationMs: Date.now() - adapterStart,
      };
    })
  );

  const finishedAt = new Date().toISOString();
  const result: OrchestratorResult = {
    startedAt,
    finishedAt,
    durationMs: Date.now() - startMs,
    adapters: adapterResults,
    totalInserted: adapterResults.reduce(
      (sum, r) => sum + (r.importResult?.inserted ?? 0),
      0
    ),
  };

  runState.lastRun = result;
  runState.running = false;

  logger.info({ durationMs: result.durationMs, totalInserted: result.totalInserted }, "Orchestrator finished");

  return result;
}
