# WoW realm catalog audit — 2026-05-20

Migration: `supabase/migrations/20260520180000_wow_servers_catalog_expansion.sql`

## What got added (rows referenced in the new migration)

- **Classic Era: 46 row references across US/EU/OCE/KR/TW.** Largest gap by far. The seed only had the Whitemane West-coast PvP cluster + the Mankrik PvE cluster; this fills in the full Faerlina East-coast PvP cluster (Benediction, Earthfury, Heartseeker, Herod, Incendius, Kirtonos, Kromcrush, Loatheb, Netherwind, Skeram, Stalagg, Sul'thraze, Sulfuras, Thalnos), all the EU EN/FR/DE/RU/ES survivors (Amnennar, Ashbringer, Auberdine, Celebras, Judgement, Zandalar Tribe, Giantstalker, Thekal, Jin'do, Sulfuron-FR, Heartstriker, Lakeshire, Chromie, Flamegor, Harbinger of Doom, Rhok'delar, Wyrmthalak, Mandokir-ES), the missing Felstriker OCE realm, plus full Korea (5) + Taiwan (2) catalogs.
- **MoP Classic: 30 row references.** Rewrote the consolidation map per Icy Veins Sept 2025. US Pagle cluster gets 12 new source realms; Grobbulus RP-PvP destination gets Earthfury. EU EN primary switched from Mograine to Mirage Raceway with full cluster wiring; Everlook DE, Auberdine FR, Flamegor RU primaries; Mandokir ES cross-locale consolidates into Mirage Raceway. Arugal OCE flipped to PvE.
- **SoD: 18 row references.** Re-asserts all NA/EU realms with correct cluster wiring (Wild Growth PvE + Crusader Strike RP-PvP for NA; Wild Growth + Living Flame for EU). Adds OCE (Penance/Shadowstrike) under `region=au`. Lava Lash re-tagged from `rp` to `pve` per source.
- **Anniversary: 7 row references.** Re-asserts the six Nov 2024 megaservers + Maladath (OCE). Normalizes Doomhowl/Soulseeker `ruleset` from null to `pvp` so OrdersTab filters work.
- **Hardcore: 6 row references.** Adds Defias Pillager + Skull Rock (the original Aug 2023 NA HC realms — seed only had Skull Rock listed and was missing Defias Pillager's `pvp` ruleset). Re-asserts Doomhowl/Soulseeker. Flags suspicious `hardcore/eu/Hyjal` and `hardcore/us/Bloodsail Buccaneers` as inactive.

## Cluster wiring

20 explicit `update … set connected_to_id` blocks across Classic Era, SoD, and MoP Classic. The Whitemane and Mankrik clusters were already wired by the seed's retail backfill script (which intentionally skipped non-retail variants), so this migration handles all the non-retail clusters explicitly. ~9 distinct megaserver primaries are now wired with their cluster members across all three variants.

## Data quality flags

1. **EU FR Amnennar vs EU EN Amnennar** — Wowpedia lists both as distinct realms but our `unique (variant, region, name)` constraint can't store both rows. Workaround documented in the migration's Phase 7 comments: add `locale` to the unique constraint when FR pricing actually surfaces in the scraper.
2. **Hardcore EU Hyjal** — flagged inactive. Wowhead's Aug 2023 HC launch announcement does not include Hyjal as a HC realm. Likely a seed-time error. If a G2G scrape returns HC Hyjal pricing, reactivate.
3. **Hardcore US Bloodsail Buccaneers** — flagged inactive. That realm is Classic Era RP, not Hardcore. Seed had it listed under both.
4. **Retail clusters not re-audited.** The existing notes-pattern + backfill script covers retail. Recommended quarterly re-audit against the official Blizzard realm-status pages once we have a fresh pricing scrape.
5. **MoP Mograine demoted** — the seed wrongly had Mograine as the EU EN PvE primary. Per Icy Veins' Sept 2025 consolidation post, Mirage Raceway is now the primary and Mograine consolidates into it. This migration corrects that wiring.

## Recommended next step for the operator

1. Apply the migration on Vercel deploy (or manually via `node scripts/apply-migrations.mjs`).
2. Run the Cowork G2G pricing scrape task once. With the expanded catalog, the previous "~623 unmapped realm-faction combos" warning should drop to near zero — anything still unmapped is a real gap (likely a Blizzard realm rename, a brand-new realm we haven't seen, or one of the data-quality flags above).
3. Open Admin → Pricing tab and verify the coverage % per variant. For MoP Classic in particular, expect a sharp jump: the previous denominator was understated (only 9 EU EN rows + the Pagle hub), so coverage should now reflect the real megaserver footprint accurately.
4. Cross-check the `pricing_intel` rows where the `item_key` mentions Mograine — those should now resolve via `connected_to_id` to Mirage Raceway and quote correctly.
