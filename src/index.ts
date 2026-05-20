/**
 * Entry point. Starts:
 *   1. Health + run HTTP server (GET /health, POST /run)
 *   2. Cron scheduler — runs orchestrator every SCRAPE_INTERVAL_MINUTES
 *
 * First run fires immediately on startup so pricing is populated right away.
 */

import cron from "node-cron";
import { runAll } from "./orchestrator.js";
import { startHealthServer } from "./health-server.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";

async function main() {
  const config = getConfig();

  // Validate env up front — process.exit on missing vars
  logger.info(
    { importUrl: config.EZLOOT_IMPORT_URL, intervalMinutes: config.SCRAPE_INTERVAL_MINUTES, port: config.PORT },
    "ezloot-pricing-feed starting"
  );

  // Start health server
  startHealthServer(config.PORT);

  // Run immediately on startup
  logger.info("Running initial scrape on startup");
  runAll().catch((err) =>
    logger.error({ error: String(err) }, "Initial scrape failed")
  );

  // Schedule recurring runs
  const cronExpression = `*/${config.SCRAPE_INTERVAL_MINUTES} * * * *`;
  logger.info({ expression: cronExpression }, "Scheduling cron");

  cron.schedule(cronExpression, () => {
    logger.info("Cron tick — starting scheduled scrape");
    runAll().catch((err) =>
      logger.error({ error: String(err) }, "Scheduled scrape failed")
    );
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
