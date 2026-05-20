/**
 * Probe candidate second-source marketplaces for accessibility from this
 * environment. We're looking for USD-quoted listing data that's NOT
 * Cloudflare-blocked.
 */

const TARGETS = [
  // Eldorado — research said "parseable"
  { label: "Eldorado OSRS gold",       url: "https://www.eldorado.gg/osrs-gold/g/10-0-0" },
  { label: "Eldorado PoE 2 currency",  url: "https://www.eldorado.gg/poe2-currency" },
  // Odealo — research said "fetched directly", 790+ PoE 2 listings
  { label: "Odealo PoE 2 currency",    url: "https://odealo.com/games/path-of-exile-2/currency" },
  // OSRS-specific aggregator
  { label: "osrsgoldprices.com",       url: "https://osrsgoldprices.com/" },
  // Direct sellers (single-source USD)
  { label: "IGGM PoE 2",               url: "https://www.iggm.com/poe-2-currency" },
  { label: "IGGM OSRS",                url: "https://www.iggm.com/runescape-gold" },
  // poe.ninja API endpoints — not USD but worth confirming we can hit them
  { label: "poe.ninja PoE 2 currency", url: "https://poe.ninja/api/data/currencyoverview?league=Fate%20of%20the%20Vaal&type=Currency" },
];

const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function probe(label: string, url: string) {
  console.log("\n" + "-".repeat(60));
  console.log(label);
  console.log("URL:", url);

  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  } catch (err) {
    console.log("STATUS: fetch threw —", String(err));
    return;
  }

  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const cloudflare = /Just a moment|cloudflare|cf-browser-verification|cf-chl|Attention Required/i.test(text);
  const captcha = /captcha|hcaptcha|recaptcha/i.test(text);

  console.log(`STATUS: ${res.status}  type=${ct}  bytes=${text.length}  cf=${cloudflare}  captcha=${captcha}`);

  // For JSON endpoints, show the top-level structure
  if (ct.includes("json")) {
    try {
      const j = JSON.parse(text);
      const keys = Object.keys(j).slice(0, 10);
      console.log(`  JSON top-level keys: ${keys.join(", ")}`);
      if (Array.isArray(j.lines)) console.log(`  .lines: array of ${j.lines.length} items`);
    } catch {
      console.log(`  (couldn't parse JSON)`);
    }
    return;
  }

  // For HTML: look for $-priced strings to see if it's giving us real data
  const priceMatches = text.match(/\$\s?\d+\.?\d*/g) ?? [];
  console.log(`  $-priced strings found: ${priceMatches.length}`);
  if (priceMatches.length > 0) {
    console.log(`  sample: ${priceMatches.slice(0, 5).join(", ")}`);
  }
}

async function main() {
  for (const t of TARGETS) {
    await probe(t.label, t.url);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
