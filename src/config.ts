import { z } from "zod";

const Env = z.object({
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on every POST to
   * the EZLoot import endpoint. The main EZLoot session must add corresponding
   * verification to /api/admin/pricing-intel/import (currently that endpoint
   * uses cookie-based owner auth; a service-token check needs to be added).
   */
  EZLOOT_IMPORT_TOKEN: z.string().min(1),
  EZLOOT_IMPORT_URL: z
    .string()
    .url()
    .default("https://admin.ezloot.gg/api/admin/pricing-intel/import"),
  /** How often to run the full scrape cycle, in minutes. */
  SCRAPE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  /** Port for the health/run HTTP server. */
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
});

let _config: z.infer<typeof Env> | null = null;

export function getConfig() {
  if (!_config) {
    const result = Env.safeParse(process.env);
    if (!result.success) {
      console.error("Missing or invalid environment variables:");
      console.error(result.error.flatten().fieldErrors);
      process.exit(1);
    }
    _config = result.data;
  }
  return _config;
}
