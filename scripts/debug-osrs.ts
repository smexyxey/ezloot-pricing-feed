/**
 * Dump raw G2G OSRS gold listings. Need to see:
 *  - Title format (does it say "OSRS Gold"? "OSRS GP"? Anything else?)
 *  - Whether unit_price is per-1-GP or per-million-GP
 *  - What min_qty / available_qty values look like
 *  - Any platform/region attributes (probably none — OSRS is single global)
 */

async function main() {
  const url = new URL("https://sls.g2g.com/offer/search");
  url.searchParams.set("service_id", "lgc_service_1");
  url.searchParams.set("brand_id", "lgc_game_19746");
  url.searchParams.set("language", "en");
  url.searchParams.set("country", "US");
  url.searchParams.set("currency", "USD");
  url.searchParams.set("page_size", "50");
  url.searchParams.set("page", "1");

  console.log("URL:", url.toString());
  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    console.error("HTTP", res.status);
    return;
  }
  const json = (await res.json()) as { payload?: { results?: unknown[] }; results?: unknown[] };
  const offers = (json?.payload?.results ?? json?.results ?? []) as Array<Record<string, unknown>>;

  console.log(`\nGot ${offers.length} offers. Sample of first 5 + last 2:\n`);
  const sampleIdxs = [...Array(Math.min(5, offers.length)).keys(), offers.length - 2, offers.length - 1].filter((i, idx, arr) => i >= 0 && i < offers.length && arr.indexOf(i) === idx);
  for (const i of sampleIdxs) {
    const o = offers[i];
    console.log(`--- offer ${i} ---`);
    console.log("title:", o.title);
    console.log("unit_price:", o.unit_price);
    console.log("available_qty:", o.available_qty);
    console.log("min_qty:", o.min_qty);
    console.log("unit_name:", o.unit_name);
    console.log("offer_attributes:", JSON.stringify(o.offer_attributes, null, 2));
    console.log("");
  }

  // Summary: distinct titles + price range
  const titles = new Set<string>();
  const unitNames = new Set<string>();
  const serverDatasets = new Set<string>();
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const o of offers) {
    titles.add(String(o.title));
    unitNames.add(String(o.unit_name));
    if (typeof o.unit_price === "number") {
      minPrice = Math.min(minPrice, o.unit_price);
      maxPrice = Math.max(maxPrice, o.unit_price);
    }
    const attrs = (o.offer_attributes as Array<Record<string, unknown>>) ?? [];
    for (const a of attrs) {
      if (a.collection_id === "lgc_19746_server") {
        serverDatasets.add(String(a.dataset_id));
      }
    }
  }
  console.log("\n---- summary ----");
  console.log("distinct titles:", [...titles]);
  console.log("distinct unit_names:", [...unitNames]);
  console.log("distinct server dataset_ids:", [...serverDatasets]);
  console.log(`unit_price range: ${minPrice} to ${maxPrice}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
