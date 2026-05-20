/**
 * One-shot G2G adapter test. Runs the adapter, prints stats + samples,
 * does NOT post to EZLoot. Use this to validate the adapter against
 * real API responses before wiring up the import endpoint.
 *
 * Usage: npx tsx scripts/test-g2g.ts
 */

import { g2gAdapter } from "../src/adapters/g2g.js";
import { createHttpClient } from "../src/http/client.js";
import { filterOutliers } from "../src/outlier-filter.js";
import type { Logger } from "../src/adapters/types.js";

// Simple console logger (avoids pino dependency for this script)
const log: Logger = {
  info: (msg, obj) => console.log(`[INFO] ${msg}`, obj ?? ""),
  warn: (msg, obj) => console.warn(`[WARN] ${msg}`, obj ?? ""),
  error: (msg, obj) => console.error(`[ERROR] ${msg}`, obj ?? ""),
  debug: (msg, obj) => console.log(`[DEBUG] ${msg}`, obj ?? ""),
};

async function main() {
  const http = createHttpClient({ maxRetries: 2, baseDelayMs: 1000 });

  console.log("=".repeat(60));
  console.log("G2G adapter test — fetching real listings");
  console.log("=".repeat(60));

  const start = Date.now();
  const rows = await g2gAdapter.fetch({ http, config: {}, log });
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  console.log("");
  console.log("=".repeat(60));
  console.log(`Adapter finished in ${duration}s — ${rows.length} rows total`);
  console.log("=".repeat(60));

  // Group by (game, category)
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.game}.${row.category}`;
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  for (const [key, groupRows] of groups) {
    console.log(`\n[${key}] ${groupRows.length} rows`);
    // Show 5 lowest-priced + 2 highest to spot bundle-listing outliers
    const sorted = [...groupRows].sort((a, b) => a.min_price_usd - b.min_price_usd);
    const cheap = sorted.slice(0, 5);
    const expensive = sorted.slice(-2);
    console.log("  cheapest 5:");
    for (const r of cheap) {
      console.log(`    $${r.min_price_usd.toFixed(8)} — ${r.item_key} (qty=${r.qty})`);
    }
    console.log("  most expensive 2:");
    for (const r of expensive) {
      console.log(`    $${r.min_price_usd.toFixed(8)} — ${r.item_key} (qty=${r.qty})`);
    }
  }

  // Run the outlier filter and report
  console.log("\n" + "=".repeat(60));
  console.log("Outlier filter results");
  console.log("=".repeat(60));
  const { rows: accepted, summary } = filterOutliers(rows);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Would POST ${accepted.length} of ${rows.length} rows to EZLoot.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
