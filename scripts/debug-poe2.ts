/**
 * Dump raw G2G PoE 2 currency listings so we can see the title shape,
 * what offer_attributes encode, how platform/league are tagged, and what
 * "official" vs "one-off bundle" listings look like.
 */

async function main() {
  const url = new URL("https://sls.g2g.com/offer/search");
  url.searchParams.set("service_id", "lgc_service_1");
  url.searchParams.set("brand_id", "lgc_game_27013");
  url.searchParams.set("language", "en");
  url.searchParams.set("country", "US");
  url.searchParams.set("currency", "USD");
  url.searchParams.set("sort", "lowest_price");
  url.searchParams.set("page_size", "10");
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

  console.log(`\nGot ${offers.length} offers. Sample:\n`);
  for (let i = 0; i < offers.length; i++) {
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

  // Build a quick taxonomy of attribute collection_ids → unique dataset_ids seen
  const attrMap = new Map<string, Set<string>>();
  for (const o of offers) {
    const attrs = (o.offer_attributes as Array<Record<string, unknown>>) ?? [];
    for (const a of attrs) {
      const collection = a.collection_id as string | undefined;
      const dataset = a.dataset_id as string | undefined;
      if (!collection || !dataset) continue;
      if (!attrMap.has(collection)) attrMap.set(collection, new Set());
      attrMap.get(collection)!.add(dataset);
    }
  }
  console.log("\nDistinct attribute collections / dataset values across sample:");
  for (const [col, ids] of attrMap) {
    console.log(`  ${col}:`, [...ids]);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
