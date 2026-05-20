/**
 * Core adapter interface. Every marketplace adapter implements this.
 * The orchestrator calls fetch() on each enabled adapter, collects
 * NormalizedRow[], filters outliers, then POSTs to EZLoot's import endpoint.
 */

export interface NormalizedRow {
  game: string;
  category: string;
  item_key: string;
  subkey?: string | null;
  /** USD per single unit. For gold: per 1 gold piece (e.g. 0.00005). For items: per item. */
  min_price_usd: number;
  avg_price_usd?: number | null;
  max_price_usd?: number | null;
  qty?: number | null;
  source_url?: string | null;
}

export interface Logger {
  info(msg: string, obj?: Record<string, unknown>): void;
  warn(msg: string, obj?: Record<string, unknown>): void;
  error(msg: string, obj?: Record<string, unknown>): void;
  debug(msg: string, obj?: Record<string, unknown>): void;
}

export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface AdapterContext {
  /** HTTP client with retry wired in. Use instead of bare fetch(). */
  http: HttpClient;
  /** Per-adapter config from config/adapters.yaml */
  config: Record<string, unknown>;
  log: Logger;
}

export interface PricingAdapter {
  /** Stable identifier — goes into pricing_intel.source */
  id: string;
  /** Human-readable name for logs */
  name: string;
  /** Returns (game, category) pairs this adapter can price. */
  coverage(): { game: string; category: string }[];
  /**
   * Fetch and normalize. Throws on hard failure.
   * Returns [] for "ran cleanly but nothing to report".
   */
  fetch(ctx: AdapterContext): Promise<NormalizedRow[]>;
}
