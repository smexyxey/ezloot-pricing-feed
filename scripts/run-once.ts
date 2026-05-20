/**
 * One-shot orchestrator run. Fetches from all adapters, filters, and POSTs
 * to the EZLoot import endpoint exactly once, then exits.
 *
 * Required env: EZLOOT_IMPORT_TOKEN
 * Optional env: EZLOOT_IMPORT_URL (defaults to production)
 *
 * Usage:
 *   EZLOOT_IMPORT_TOKEN=<token> npx tsx scripts/run-once.ts
 */

import { runAll } from "../src/orchestrator.js";

async function main() {
  console.log("Starting one-shot orchestrator run...\n");
  const result = await runAll();
  console.log("\n" + "=".repeat(60));
  console.log("Final result:");
  console.log("=".repeat(60));
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
