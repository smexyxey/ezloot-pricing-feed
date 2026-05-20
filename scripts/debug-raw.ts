/**
 * Dump raw G2G API responses so we can see actual unit_price / available_qty
 * / offer_attributes shapes. Used to debug the gold unit math and item
 * categorization. Run once, eyeball the output.
 */

async function main() {
  const targets = [
    { label: "WoW Anniversary gold", brand: "lgc_game_27816", service: "lgc_service_1" },
    { label: "Arc Raiders items", brand: "lgc_game_35181", service: "0765978e-3fdf-48b4-bed3-184823aa439e" },
  ];

  for (const t of targets) {
    const url = new URL("https://sls.g2g.com/offer/search");
    url.searchParams.set("service_id", t.service);
    url.searchParams.set("brand_id", t.brand);
    url.searchParams.set("language", "en");
    url.searchParams.set("country", "US");
    url.searchParams.set("currency", "USD");
    url.searchParams.set("sort", "lowest_price");
    url.searchParams.set("page_size", "3");
    url.searchParams.set("page", "1");

    console.log("\n" + "=".repeat(60));
    console.log(t.label);
    console.log("=".repeat(60));
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
      continue;
    }
    const json = (await res.json()) as { payload?: { results?: unknown[] }; results?: unknown[] };
    const offers = (json?.payload?.results ?? json?.results ?? []) as Array<Record<string, unknown>>;

    console.log(`Got ${offers.length} offers. Sample:\n`);
    for (let i = 0; i < Math.min(3, offers.length); i++) {
      const offer = offers[i];
      console.log(`--- offer ${i} ---`);
      console.log("title:", offer.title);
      console.log("unit_price:", offer.unit_price);
      console.log("available_qty:", offer.available_qty);
      console.log("total_stock:", offer.total_stock);
      console.log("listing_id:", offer.listing_id);
      console.log("offer_attributes:", JSON.stringify(offer.offer_attributes, null, 2));
      // dump a couple other potentially-useful keys
      const interesting = ["min_qty", "max_qty", "unit_name", "category_id", "category_name", "currency"];
      for (const k of interesting) {
        if (k in offer) console.log(`${k}:`, offer[k]);
      }
      console.log("");
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
