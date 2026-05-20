# ezloot-pricing-feed

Standalone Node.js/TypeScript service that polls G2G (and eventually other marketplaces) for pricing data and posts normalized rows to EZLoot's import endpoint. Replaces the manual Cowork-scheduled scraper.

## Architecture

```
Scheduler (node-cron, every 30 min)
  └─► Orchestrator
        ├─► G2G adapter       → sls.g2g.com/offer/search
        └─► Manual seed adapter → config/manual-seeds.yaml
              │ all adapters emit NormalizedRow[]
        ├─► Outlier filter (drops low-qty, extreme outliers)
        └─► POST /api/admin/pricing-intel/import on admin.ezloot.gg

HTTP server (port 8080)
  GET /health  → last run time, per-adapter status
  POST /run    → trigger immediate scrape (admin-token-gated)
```

## Prerequisites

### Auth — required before first deploy

The EZLoot import endpoint (`app/api/admin/pricing-intel/import/route.ts`) currently uses cookie-based owner auth. The new service sends `Authorization: Bearer <token>`. The **main EZLoot session** must add service-token verification to that route before rows will land.

Suggested patch to the import route:

```ts
// At the top of the POST handler, before requireRole():
const authHeader = req.headers.get("authorization") ?? "";
const serviceToken = authHeader.replace(/^Bearer\s+/i, "");
if (serviceToken && serviceToken === process.env.PRICING_FEED_TOKEN) {
  // Valid service call — skip session auth
} else {
  const auth = await requireRole("owner");
  if (auth instanceof NextResponse) return auth;
}
```

Add `PRICING_FEED_TOKEN=<same-token>` to EZLoot's Vercel env vars.

## Deploy to Fly.io

### First deploy

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Create app (one-time)
fly launch --no-deploy

# Set secrets
fly secrets set EZLOOT_IMPORT_TOKEN=<token>
fly secrets set EZLOOT_IMPORT_URL=https://admin.ezloot.gg/api/admin/pricing-intel/import

# Deploy
fly deploy
```

### GitHub Actions (auto-deploy on push to main)

Add `FLY_API_TOKEN` to your GitHub repo secrets (`Settings → Secrets → Actions`).
Get the token from: `fly tokens create deploy`

## Local development

```bash
cp .env.example .env   # fill in EZLOOT_IMPORT_TOKEN
npm install
npm run dev
```

The dev server runs the scraper once on startup and again every `SCRAPE_INTERVAL_MINUTES` minutes. Logs are pretty-printed in development.

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `EZLOOT_IMPORT_TOKEN` | Yes | — | Bearer token for the import endpoint |
| `EZLOOT_IMPORT_URL` | No | `https://admin.ezloot.gg/api/admin/pricing-intel/import` | Override for local testing |
| `SCRAPE_INTERVAL_MINUTES` | No | `30` | Cron interval |
| `PORT` | No | `8080` | Health server port |
| `LOG_LEVEL` | No | `info` | pino log level |

## Triggering a manual run

```bash
curl -X POST https://ezloot-pricing-feed.fly.dev/run \
  -H "Authorization: Bearer <EZLOOT_IMPORT_TOKEN>"
```

Returns `202 Accepted` immediately; run completes in background. Check `/health` for results.

## Checking health

```bash
curl https://ezloot-pricing-feed.fly.dev/health | jq .
```

Response shape:
```json
{
  "ok": true,
  "running": false,
  "last_run_at": "2026-05-20T10:00:00.000Z",
  "last_run_duration_ms": 45230,
  "last_run_inserted": 842,
  "adapters": [
    {
      "id": "g2g",
      "status": "ok",
      "rows_inserted": 830,
      "error": null,
      "duration_ms": 44100
    },
    {
      "id": "manual_seed",
      "status": "ok",
      "rows_inserted": 12,
      "error": null,
      "duration_ms": 5
    }
  ]
}
```

## Adding a new adapter

1. Create `src/adapters/<name>.ts` implementing `PricingAdapter`:

```ts
import type { PricingAdapter, NormalizedRow } from "./types.js";

export const myAdapter: PricingAdapter = {
  id: "my_source",
  name: "My Source",
  coverage() {
    return [{ game: "osrs", category: "gold" }];
  },
  async fetch(ctx) {
    // ctx.http.fetch() — retries wired in, swap for proxy in v2
    // ctx.log.info() — structured logging
    // ctx.config — per-adapter config from config/adapters.yaml
    const rows: NormalizedRow[] = [];
    // ... fetch, parse, normalize ...
    return rows;
  },
};
```

2. Register it in `src/orchestrator.ts`:

```ts
import { myAdapter } from "./adapters/my-source.js";
const ADAPTERS: PricingAdapter[] = [g2gAdapter, manualSeedAdapter, myAdapter];
```

3. Add optional config to `config/adapters.yaml`.

### NormalizedRow shape

```ts
{
  game: string;        // EZLoot canonical key, e.g. "wow_classic_era_anniversary"
  category: string;   // "gold" | "blueprints" | "items" | "carry" | ...
  item_key: string;   // "Nightslayer - Horde" for gold, item name for items
  subkey?: string;    // variant tag or null
  min_price_usd: number;  // USD per 1 unit (per-1-gold for gold)
  avg_price_usd?: number;
  max_price_usd?: number;
  qty?: number;
  source_url?: string;
}
```

**Gold unit normalization:** EZLoot stores gold prices in USD per 1 gold piece (tiny numbers like `0.0000563`). If your source prices per-K or per-100K, divide accordingly before returning.

## Debugging a failing adapter

1. Check `/health` for `status: "error"` and `error` message
2. Pull logs: `fly logs`
3. Trigger a manual run and watch logs: `fly logs -f` then `POST /run`
4. Disable a specific target via `config/adapters.yaml` → `disabled_targets` to isolate

## G2G adapter notes

- **No `region_id` param** — the EU UUID (`ac3f85c1-7562-437e-b125-e89576b9a38e`) silently drops all non-EU listings. Never add it back.
- **Gold unit**: divides `unit_price / available_qty` to get per-1-gold. Verify against real API responses if prices look wrong (the outlier filter caps at $1/gold and will reject bad conversions).
- **Rate limiting**: 1 req/sec per page + 2–4s between targets. G2G's API endpoint (`sls.g2g.com`) is less aggressive than the consumer site.
- **Brand IDs**: `lgc_game_27816` (WoW Classic/Anniversary/SoD), `lgc_game_29076` (MoP Classic), `lgc_game_2299` (Retail), `lgc_game_35181` (Arc Raiders).

## Roadmap

- [ ] **Auth patch on EZLoot import endpoint** (main EZLoot session) — service token check
- [ ] **PlayerAuctions adapter** — pending GAME_RESEARCH_BRIEF.md results for OSRS, Destiny 2, PoE 2
- [ ] **Residential proxy** — wire into `HttpClient` via env config if G2G blocks the Fly.io egress IP
- [ ] **Slack/Discord webhook** on adapter failure
- [ ] **WoW variant disambiguation** — cross-reference `wow_servers` API to split `lgc_game_27816` results by variant (anniversary vs. classic_era vs. sod vs. hardcore)
- [ ] **Admin UI** on `admin.ezloot.gg/pricing-feed` showing service health (main EZLoot session)
