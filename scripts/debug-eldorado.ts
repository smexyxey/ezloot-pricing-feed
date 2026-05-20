/**
 * Dig into Eldorado.gg — find PoE 2 URL, see how listings are structured.
 * Look for: __NEXT_DATA__, API JSON endpoints, or parseable price markers.
 */

const TARGETS = [
  { label: "Eldorado OSRS gold listings",   url: "https://www.eldorado.gg/osrs-gold/g/10-0-0" },
  { label: "Eldorado PoE 2 (slug variants)", url: "https://www.eldorado.gg/path-of-exile-2-currency" },
  { label: "Eldorado PoE 2 alt",             url: "https://www.eldorado.gg/poe-2-currency" },
  { label: "Eldorado WoW gold US",           url: "https://www.eldorado.gg/wow-classic-gold" },
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
    console.log("FAIL:", String(err));
    return;
  }
  console.log("status:", res.status, "final URL:", res.url);
  const text = await res.text();
  console.log("body bytes:", text.length);

  // Look for __NEXT_DATA__ (Next.js / Vercel apps often expose page data)
  const next = text.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/);
  if (next) {
    console.log(`✓ __NEXT_DATA__ found (${next[1].length} bytes)`);
    try {
      const j = JSON.parse(next[1]);
      console.log("  top keys:", Object.keys(j).slice(0, 20));
      if (j.props?.pageProps) {
        console.log("  pageProps keys:", Object.keys(j.props.pageProps).slice(0, 20));
      }
      // Drill into common shapes
      const dive = (obj: unknown, path: string[] = [], depth = 0): void => {
        if (depth > 4) return;
        if (typeof obj !== "object" || obj === null) return;
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
            console.log(`  array at ${[...path, k].join(".")}: ${v.length} items, first item keys=${Object.keys(v[0] as object).slice(0, 8).join(",")}`);
          } else {
            dive(v, [...path, k], depth + 1);
          }
        }
      };
      dive(j.props?.pageProps);
    } catch (e) {
      console.log("  (parse fail:", String(e).slice(0, 100), ")");
    }
  } else {
    console.log("✗ no __NEXT_DATA__");
  }

  // Look for any JSON-LD
  const ld = text.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]+?)<\/script>/g);
  if (ld) console.log(`✓ ${ld.length} ld+json blocks`);

  // Title for sanity
  const title = text.match(/<title>([^<]+)<\/title>/);
  if (title) console.log("page title:", title[1]);
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
