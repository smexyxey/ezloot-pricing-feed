/**
 * Probe PlayerAuctions to figure out what's scrapable.
 *
 * Tests three surfaces:
 *  1. Market price tracker pages (aggregated daily averages)
 *  2. Listing category pages (per-seller prices)
 *  3. Any JSON endpoints we can discover
 *
 * Looking for: HTTP status, content-type, response body size, evidence of
 * Cloudflare interstitial, embedded JSON data, or a hidden API.
 */

const TARGETS = [
  { label: "OSRS market tracker",         url: "https://www.playerauctions.com/market-price-tracker/osrs/" },
  { label: "OSRS gold listings",          url: "https://www.playerauctions.com/osrs-gold/" },
  { label: "PoE2 market tracker",         url: "https://www.playerauctions.com/market-price-tracker/path-of-exile-2/" },
  { label: "PoE2 Divine Orb listings",    url: "https://www.playerauctions.com/path-of-exile-2-currency/divine-orb/" },
];

const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function probe(label: string, url: string) {
  console.log("\n" + "=".repeat(60));
  console.log(label);
  console.log("URL:", url);
  console.log("=".repeat(60));

  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  } catch (err) {
    console.error("Fetch threw:", String(err));
    return;
  }

  console.log("status:", res.status);
  console.log("content-type:", res.headers.get("content-type"));
  console.log("cf-cache-status:", res.headers.get("cf-cache-status"));
  console.log("cf-ray:", res.headers.get("cf-ray"));
  console.log("server:", res.headers.get("server"));

  const text = await res.text();
  console.log("body bytes:", text.length);

  // Quick sniffs
  if (/Just a moment|cloudflare|cf-browser-verification|cf-chl/i.test(text)) {
    console.log("⚠️  Cloudflare interstitial detected");
  }
  if (/captcha|hcaptcha|recaptcha/i.test(text)) {
    console.log("⚠️  CAPTCHA detected");
  }

  // Look for embedded JSON data common patterns
  const patterns = [
    { name: "__NEXT_DATA__", re: /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([^<]+)<\/script>/i },
    { name: "window.__INITIAL_STATE__", re: /window\.__INITIAL_STATE__\s*=\s*(\{.+?\});/ },
    { name: "window.__data__", re: /window\.__data__\s*=\s*(\{.+?\});/ },
    { name: "ld+json", re: /<script[^>]*type=["']application\/ld\+json["'][^>]*>([^<]+)<\/script>/i },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) {
      console.log(`✓ Found ${p.name} (${m[1].length} bytes of JSON)`);
      // Try to peek at structure
      try {
        const j = JSON.parse(m[1]);
        const keys = Object.keys(j).slice(0, 10);
        console.log(`  top-level keys: ${keys.join(", ")}`);
      } catch (e) {
        console.log(`  (couldn't parse JSON: ${e})`);
      }
    }
  }

  // Show first ~400 chars of body for visual inspection
  const preview = text.slice(0, 400).replace(/\s+/g, " ");
  console.log("body preview:", preview);
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
