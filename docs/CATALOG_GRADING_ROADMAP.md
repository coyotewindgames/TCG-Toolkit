# Catalog & Grading Roadmap

Two proposals for the inventory and trade-in platform: retiring TCGapi.dev in favor of PkmnPrices.com as the sole
catalog and pricing provider, and promoting graded cards — PSA, CGC, Beckett, TAG — to a first-class concept in
pricing, search, and nightly sync.

> Prepared from a full-repo audit of `TCG-Toolkit` @ `main` (`3eef858`) · 2026-08-12 · **Status: draft, for review**

## Contents

**Part A — Retire TCGapi.dev**
- [A.0 Where things actually stand](#a0-where-things-actually-stand)
- [A.1 Touchpoint inventory](#a1-touchpoint-inventory)
- [A.2 TCGapi vs. PkmnPrices](#a2-tcgapi-vs-pkmnprices)
- [A.3 The decision this depends on](#a3-the-decision-this-depends-on)
- [A.4 Migration phases](#a4-migration-phases)
- [A.5 Data migration specifics](#a5-data-migration-specifics)
- [A.6 Risks](#a6-risks)
- [A.7 Rollout](#a7-rollout)
- [A.8 Effort](#a8-effort)

**Part B — Graded cards, first-class**
- [B.0 The gap, stated plainly](#b0-the-gap-stated-plainly)
- [B.1 Four verified findings](#b1-four-verified-findings)
- [B.2 What "first-class" requires](#b2-what-first-class-requires-layer-by-layer)
- [B.3 Proposed domain model](#b3-proposed-domain-model)
- [B.4 Pricing pipeline](#b4-pricing-pipeline)
- [B.5 Search, catalog & labels](#b5-search-catalog--labels)
- [B.6 Nightly sync](#b6-nightly-sync)
- [B.7 Intake UX](#b7-intake-ux)
- [B.8 Migration phases](#b8-migration-phases)
- [B.9 Risks](#b9-risks)
- [B.10 Effort](#b10-effort)

**Combined**
- [C.0 Recommended sequencing](#c0-recommended-sequencing)
- [C.1 Decisions needed from you](#c1-decisions-needed-from-you)
- [C.2 Full touchpoint appendix](#c2-full-touchpoint-appendix)

---

# Part A — Retire TCGapi.dev

Make PkmnPrices.com the sole catalog and pricing API — finishing a migration that is already partway shipped.

## A.0 Where things actually stand

This migration is further along than it looks. A parallel `/pkmnprices/*` API — sets, search, card prices —
already exists, is explicitly commented as mirroring the shape of the old `/tcgapi/*` routes on purpose, and the
Trade-In register already calls it exclusively for Pokémon search and pricing. Three migrations
(`0011`–`0013`) and a one-off backfill script already shipped the credential table, the price-source enum values,
and the product-identity column this needed.

What's left is smaller than a rewrite: a nightly catalog-metadata job that never got switched over, an onboarding
gate and a settings panel still wired to the old provider, one analytics widget with no PkmnPrices equivalent, and
— the part no amount of engineering fixes — eight of the nine supported game categories that PkmnPrices simply
doesn't carry.

> **Recommendation.** Adopt PkmnPrices as the sole priced/searched catalog provider for Pokémon — finish the
> migration already in progress — and keep non-Pokémon inventory alive as a manually-priced, manually-searched
> category rather than promising an automated provider that doesn't exist for those games. That's **Option 3** in
> A.3, and it's already the direction `backfill-pkmnprices-ids.ts` points: its own comment says non-matched
> products "keep their NULL id and the pricing router falls back to tcgapi for them."

## A.1 Touchpoint inventory

Every subsystem that currently touches TCGapi, and how far each one already is from done.

| Subsystem | Status | Files |
|---|---|---|
| Trade-in card search (sets, name search, prices) | **Done** | `routes/pkmnprices.ts`, `useTradeTransaction.ts`, `TradeIn.tsx` |
| Price refresh (nightly bulk + on-scan) | **Partial** — done for matched Pokémon SKUs; TCGapi is the live fallback for everything else | `pricing-router.ts`, `worker.ts` (bulkRefresh) |
| Product → provider identity backfill | **Done**, one-off, Pokémon only | `scripts/one-off/backfill-pkmnprices-ids.ts` |
| Catalog metadata refresh (name/set/number/rarity) | **Not started** — 100% TCGapi, no PkmnPrices branch exists | `worker.ts` (syncCatalog), `jobs/cron/catalog-sync.ts` |
| Analytics "Top Movers" widget | **Not started** — no PkmnPrices equivalent exists at all | `pages/Analytics.tsx`, `routes/tcgapi.ts` |
| Onboarding "connect a catalog provider" step | **Not started** — hard-required gate is TCGapi-only | `pages/Onboarding.tsx` |
| Settings → "Trade-In search games" selector | **Dead config** — nothing reads `queryGameSlugs` anymore now that trade-in search is PkmnPrices-only | `SettingsIntegrations.tsx` |
| `/tcgapi/search`, `/games/:slug/sets`, `/cards/:id/prices` | **Apparently dead** — no caller found anywhere in `apps/web`; confirm before deleting (Phase A0) | `routes/tcgapi.ts` |
| Non-Pokémon catalog (mtg, yugioh, lorcana, one_piece, flesh_and_blood, sealed, supplies, other) | **Structural** — search, identity, and pricing all depend on TCGapi by definition | `db/schema/enums.ts` (gameEnum) |
| SKU identity hashing | **Needs rework** — shared helper is keyed on `tcgapiProductId`; a second, differently-keyed implementation lives locally in the import service | `packages/shared/src/index.ts`, `inventory-import/service.ts` |

## A.2 TCGapi vs. PkmnPrices

| Capability | TCGapi.dev | PkmnPrices.com |
|---|---|---|
| Games covered | All nine: mtg, pokemon, yugioh, lorcana, one_piece, flesh_and_blood, sealed, supplies, other | Pokémon (cards + sealed) only |
| Card search | Yes, all games | Yes, Pokémon only |
| Set listing | Yes, all games | Yes, Pokémon only |
| Pricing sources | One blended market/low/median/buylist figure | Three sources: TCGplayer, eBay sold, Cardmarket (EUR, Pro+) |
| Graded / sold comps | None — no grade concept in the wire format | Yes — `cards.listings.ebay(id, { grader, grade })`; `grade` is also a general search param |
| Sealed product pricing | Folded into the general catalog | Dedicated `sealed` resource: list / get / priceHistory / listings |
| Price history | Not exposed by the client used here | `cards.priceHistory` — daily avg / low / high / sale_count |
| Trending / top movers | Yes, dedicated endpoint | No equivalent |
| Images | Used for non-Pokémon only — Pokémon images already come from pkmncards.com | Not a documented field on the types this client uses |
| Rate limits | Free tier excludes bulk endpoints | 60 rpm, SDK-retried; separate daily credit ceiling that doesn't reset on retry |

## A.3 The decision this depends on

Everything else in Part A is straightforward engineering. This isn't — it's a product decision about the eight of
nine game categories PkmnPrices cannot serve, and no routing logic resolves that for you.

**Option 1 — Hard cutover.**
Drop non-Pokémon support outright: hide those games from product creation and search, leave existing rows as
static, unpriced, unsynced inventory. Simplest to build — but an MTG or Yu-Gi-Oh SKU that sells today silently
stops getting price refreshes the day this ships.

**Option 2 — Soft sunset.**
Same end state as Option 1, telegraphed: flag non-Pokémon products "unmanaged" in the UI for a deprecation window
before the sync code is actually deleted.

**Option 3 — Manual-only multi-game. (Recommended)**
PkmnPrices becomes the only *API* provider — literally true — but non-Pokémon inventory keeps working as a
manually-priced, manually-searched category: staff can still create products, print barcodes, sell, and take
trade-ins for MTG/Yu-Gi-Oh/etc. by hand, with `manual_override` as the only price source and no nightly sync
attempted. This is closer to today's reality than it sounds — the Trade-In search box has been Pokémon-only in
practice since the `/pkmnprices/*` switch, and the "search games" selector in Settings is already dead code for
that flow.

## A.4 Migration phases

**Phase A0 · Confirm scope** — *Lock the game-scope decision and spike two unknowns, no code*
- Decide between Options 1/2/3 above (A.3).
- Spike: confirm nothing calls `/tcgapi/search`, `/tcgapi/games/:slug/sets`, or `/tcgapi/cards/:id/prices` in
  production before deleting them.
- Spike: call `cards.priceHistory` against a real card id and check whether `condition` ever holds a graded label
  like `"PSA 10"` on eBay-sourced rows — this changes Part B's pricing design (B.4), so it's worth resolving here.
- **Exit criteria:** game-scope option chosen and written down; both spikes answered.

**Phase A1 · Catalog metadata sync** — *Give the nightly metadata job a PkmnPrices path*
- `jobs/worker.ts` — branch `syncCatalog` on `game === 'pokemon' && pkmnpricesProductId != null` →
  `PkmnPricesClient.getCard()`; keep (or retire, per A.3) the TCGapi branch for other games.
- `jobs/cron/catalog-sync.ts` — stop gating the whole cron on `tcgapi_configs` having a key; stop looping the full
  `GAMES` enum for Pokémon-only stores.
- **Exit criteria:** a Pokémon-only store's nightly cron enqueues zero TCGapi-dependent jobs.

**Phase A2 · Onboarding & settings** — *Point the required setup step at PkmnPrices*
- `pages/Onboarding.tsx` — swap the gating check and connect form to PkmnPrices.
- `pages/SettingsIntegrations.tsx` — remove `TcgapiQueryGamesCard`; demote or remove the TCGapi credentials panel
  per the A.3 decision.
- **Exit criteria:** a new store completes onboarding without ever seeing TCGapi.

**Phase A3 · Top Movers replacement** — *Resolve the one true capability gap*
- Option (a): compute a lightweight "movers" view from your own `price_snapshots` history — latest vs. 7-day-old
  snapshot per SKU. You already capture the data; you're just not diffing it.
- Option (b): drop the widget.
- Either way: `pages/Analytics.tsx`, `routes/tcgapi.ts` (getTopMovers).
- **Exit criteria:** Analytics has no remaining TCGapi dependency.

**Phase A4 · Data & schema cleanup** — *Remove TCGapi's footprint once nothing reads it live*
- See A.5 for the full list: `price_source` enum, `tcgapiProductId` disposition, `skuIdentityKey`, config tables,
  vault entries, `container.ts`, env vars, `render.yaml`.
- **Exit criteria:** `grep -ri tcgapi apps/` returns nothing outside a changelog entry.

**Phase A5 · Decommission** — *Delete what A0's spike confirmed is dead*
- Delete `integrations/tcgapi/client.ts`, `routes/tcgapi.ts`, `tcgapiFor` in `container.ts`, the `tcgapi_configs`
  table, and TCGapi-shaped env vars from `.env.example` and `render.yaml`.
- **Exit criteria:** build and tests green with the integration fully removed.

## A.5 Data migration specifics

- **`price_source` enum** — Postgres enum values can't be dropped in place. Leaving `tcgapi_market` /
  `tcgapi_low` / `tcgapi_median` / `tcgapi_buylist` defined-but-unused is the cheap, recommended option over a
  rename-type/migrate/drop dance. Historical `price_snapshots` rows tagged with those sources are real pricing
  history — don't delete them; `pricing.ts`'s `recomputeCurrent` pivot just stops selecting from them once nothing
  writes new ones.
- **`products.tcgapiProductId`** — keep the column, nullable, as provenance on existing rows. Dropping a column on
  a live table is a one-way door this project doesn't need to walk through.
- **`skuIdentityKey`** (`packages/shared/src/index.ts`) — today's signature is `{ tcgapiProductId, condition,
  printing, language }`. It needs to become provider-agnostic: key off `products.id` the way the second,
  locally-duplicated implementation in `inventory-import/service.ts` already does. Worth reconciling both in the same
  pass — they've drifted, and having one canonical version removes the risk of the CSV-import path and the
  trade-in path de-duping SKUs differently.
- **Credentials** — `tcgapi_configs` and its vault-encrypted columns drop only after Phase A5.
  `config_audit_log` rows referencing it as `table_name` are history, not live config — leave them.

## A.6 Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Non-Pokémon stores lose live functionality | Options 1/2 are a real feature regression for anyone actually stocking MTG or Yu-Gi-Oh today | Confirm actual non-Pokémon inventory volume before choosing in A.3; Option 3 avoids this entirely |
| PkmnPrices rate/credit limits under full nightly load | Adding a catalog-metadata job on top of the existing price-refresh job roughly doubles call volume | Reuse the `pLimit(3)` pattern from `backfill-pkmnprices-ids.ts`; consider one call per card covering both metadata and price, since `cards.get()` returns both |
| True single point of failure | TCGapi was already the sole catalog source per `docs/PLAN.md`, but this removes even the theoretical fallback the pricing router has today | Accept it as a known tradeoff, or keep the TCGapi client unwired as a documented emergency fallback rather than deleting it in A5 |
| Onboarding regression | The gating step is a hard blocker — a bug in the swapped form means nobody can finish setup | Ship A2 behind a flag for one store before flipping the default |

## A.7 Rollout

Stage by store, not by code path: flip PkmnPrices-only mode for one internal or test store first, watch a full
nightly cron cycle end to end (catalog-sync *and* bulkRefresh), then default it for new signups, then migrate
existing stores' onboarding state so they stop seeing the TCGapi step.

## A.8 Effort

| Phase | Size | Why |
|---|---|---|
| A0 Confirm scope | S | Decision + two spikes, no code |
| A1 Catalog metadata sync | M | Closely mirrors the existing PricingRouter pattern |
| A2 Onboarding & settings | S–M | Mostly swapping which provider a form targets; UI already exists for both |
| A3 Top Movers replacement | M / S | M if self-served from snapshot history, S if the widget is just cut |
| A4 Data & schema cleanup | M | Mechanical, but touches a shared package consumed by both apps |
| A5 Decommission | S | Delete once A0–A4 are verified live |

---

# Part B — Graded cards, first-class

Give PSA / CGC / Beckett / TAG cards a real place in the data model, pricing, search, and nightly sync.

## B.0 The gap, stated plainly

Right now, a PSA 10 and a raw Near Mint copy of the same card are the same database row, except for whatever
number a staff member typed into "Override unit value." No column records the grading company, the grade, or a
cert number. No pricing path adjusts for it.

And — worth sitting with — raw condition doesn't affect pricing yet either, so grading isn't a regression from
some prior working state. It's the next layer on a foundation that isn't fully poured. The four findings below are
verified against the current code, not assumed.

## B.1 Four verified findings

**Finding 1 — No schema for grading, anywhere.**
`apps/api/src/db/schema/enums.ts` — `cardConditionEnum` is `['NM','LP','MP','HP','DMG']` and nothing else.
`skus_identity_uq` is a four-column unique constraint (`productId, condition, printing, language`) with no grade
dimension. `trade_items` and `order_items` carry no grading columns either. A graded card has nowhere to live
except inside a `condition` value that doesn't describe it.

**Finding 2 — Pricing already ignores condition, so it can't yet respect grade.**
`apps/api/src/server/services/pricing-router.ts:162` — the call to `pickBestTcgplayerPrice(prices, { condition:
'NM', printing })` passes the literal string `'NM'`, not the SKU's actual condition, and the `SkuContext` this
runs against doesn't even `select` the SKU's `condition` column from the database. Every LP/MP/HP/DMG SKU of a
product is priced today as if it were Near Mint.

**Finding 3 — The trade-in valuation function takes a condition and never uses it.**
`apps/api/src/server/services/tradeins.ts` — `computeSuggestedUnitValueCents()` destructures `condition` into its
arguments and never reads it in the body. The tier table in `docs/PLAN.md` (NM 0.65 / LP 0.55 / MP 0.45 / HP 0.30
/ DMG 0.15) describes intent that was never wired in — only the flat `PAYOUT_MULTIPLIERS` (cash 0.7 / store_credit
0.8) actually apply.

**Finding 4 — The UI already invented a graded-card flow. It just doesn't save anything.**
`apps/web/src/pages/TradeIn.tsx:103–108, 520–522, 858–910` — a working "Graded card" toggle exists today:
`GRADING_COMPANIES = ['PSA','CGC','Beckett','TAG']`, a per-company grade list, and a generated eBay sold-listings
search link staff open in a new tab to eyeball comps by hand. `isGraded` / `gradingCompany` / `gradedGrade` are
local component state — none of it reaches the trade-in submission payload. This is real, validated product
thinking with zero backend behind it: the fastest path to "first-class" is finishing what this screen already
started, not designing from scratch.

## B.2 What "first-class" requires, layer by layer

| Layer | Today | Target |
|---|---|---|
| Data model | Grade lives nowhere | `skus` carries grading company, grade, and cert number as first-class, indexed columns |
| Pricing | Raw condition ignored; grade has no data source | Grade-aware SKUs pull real sold-comp aggregates from PkmnPrices' eBay listings endpoint |
| Search / catalog | No grade facet anywhere | Intake and inventory search filter by grading company + grade, same as existing rarity/number filters |
| Nightly sync | N/A | Graded SKUs get their own, slower refresh cadence (B.6) |
| Intake / UX | Toggle exists, discards everything on submit | Same toggle, wired to real fields — the eBay link becomes supporting evidence, not the only mechanism |
| Labels & ops | Barcode/label PDFs print condition only | Labels print grading company + grade + cert number |

## B.3 Proposed domain model

- New enum **`card_grading_company`**: `psa | cgc | beckett | tag | sgc | other`.
- New nullable columns on `skus`: **`gradingCompany`** (the enum above), **`grade`** (varchar — grades like "9.5"
  aren't integers, and graders use different scales), **`certNumber`** (text, indexed — useful later for catching
  a duplicate cert across trade-ins).
- `skus_identity_uq` extends to `(productId, condition, printing, language, gradingCompany, grade)` — a raw NM
  copy and a PSA 10 copy of the same product are obviously different inventory lines, but the constraint doesn't
  currently have the columns to express that.
- `condition` becomes nullable specifically for graded SKUs — the third-party grade supersedes the in-house tier
  rather than running parallel to it. Simplest option: allow `condition IS NULL` when `gradingCompany IS NOT NULL`,
  enforced with a `CHECK` constraint, rather than inventing a sixth `card_condition` value that just means "see
  grade instead."
- No new tables for `price_snapshots` / `current_prices` — both already key off `skuId`, and grade now lives on
  the SKU, so a graded SKU's price history is just its own row, same as any other SKU. That reuses the existing
  pricing tables instead of forking them.
- New `price_source` value: `pkmnprices_graded_ebay` — distinct from `pkmnprices_market` so the pivot in
  `pricing.ts` can tell a real TCGplayer market number from an aggregated eBay sold-comp estimate.

## B.4 Pricing pipeline

The current `PkmnPricesClient` wrapper only exposes `cards.list/get` and `sets.list/listAll` — it never touches
`cards.listings`, the SDK resource that actually carries grading data. That's genuinely new client work, not a
config flip.

- Wrap `client.cards.listings.iterateEbay(cardId, { grader, grade })` → `EbayListing { title, price, grader,
  grade, sale_type, sold_at, listing_url }`. This resource is cursor-paginated, unlike everything else the current
  client wraps — a genuinely different code shape from `getCard` / `searchCards`, even with the SDK's iterator
  helper doing the work.
- **Aggregation:** pull recent sold listings over a rolling window (60–90 days), require a minimum sample (3–5
  sales) before trusting the aggregate, take the *median* (a single outlier auction shouldn't move the price the
  way it would in a mean), and fall back to "no automated price, use Override" — the exact manual path that
  already exists per Finding 4 — when the sample is too thin. Low-volume grades will hit that fallback often;
  that's not a new UX, it's the existing one becoming the graceful-degradation path instead of the only path.
- **Spike first** (same item as Phase A0): `client.cards.priceHistory(id, …)` returns pre-aggregated `{ avg, low,
  high, sale_count, condition, source }` points. If the live API ever populates `condition` with a graded label on
  `source: 'ebay'` rows, that's a cheaper, pre-computed alternative to pulling and aggregating raw listings. The
  SDK's types don't settle this either way — it's a 20-minute API call, and it decides whether this phase is "call
  an aggregate endpoint" or "build an aggregator."
- **Cost:** the SDK's error model exposes `creditsCharged` per request, implying listings calls are metered like
  everything else. Don't fold graded-SKU refresh into the nightly raw-price loop — see B.6.

## B.5 Search, catalog & labels

- Trade-in intake search already has a filter pattern (`q`, `setId`, `number`, `rarity`) applied client-side via
  `applyClientFilters`-style logic. Add `gradingCompany` / `grade` as the same shape of optional filter.
- Inventory search and list (`pages/Inventory.tsx`) need a grade column and filter facet alongside the existing
  condition/printing/language ones.
- Barcode & label PDFs (`POST /api/skus/labels.pdf`) currently template off condition/printing — add grading
  company, grade, and cert number as label tokens. Worth noting: the Electron precursor tool that predates this
  monorepo (`app/src/lib/converter.js`, same working directory) already had a `{grade}` template token. This isn't
  a new idea for the product — the gap opened when the desktop tool was rebuilt as the current platform and
  grading didn't make the jump.
- Analytics ("top cards by line value" and similar) should be able to break out graded vs. raw — a handful of
  slabs can dominate a store's total inventory value in a way raw-condition breakdowns hide today.

## B.6 Nightly sync

Raw-card pricing already refreshes on a nightly cron plus on-demand at scan time. Graded SKUs shouldn't share that
cadence: volume is much lower (most stores carry far fewer graded slabs than raw singles) but per-card cost is
much higher (a listings pull plus aggregation vs. one cached market-price field), so a nightly full-catalog loop
is the wrong shape.

Recommended: refresh a graded SKU's price on trade-in intake and on a manual "refresh" action in inventory, plus a
slower *weekly* batch job for graded SKUs that haven't been touched recently — reusing the batching pattern
already established in `catalog-sync.ts` and `backfill-pkmnprices-ids.ts` rather than inventing a new job shape.

## B.7 Intake UX

- Wire `isGraded` / `gradingCompany` / `gradedGrade` (`TradeIn.tsx`) into the actual submit payload —
  `TradeItemInput` in `packages/shared/src/index.ts` gains `gradingCompany?` / `grade?` / `certNumber?`, matching
  the optional-field pattern already used for `overrideValueCents` and `marketPriceCents`.
- Add a cert-number input next to the existing grade dropdowns — useful for authenticity records on its own, and
  the natural key if a later pass wants to flag a cert number that's already in the system, a real fraud vector
  specific to graded cards.
- Consider a slab-photo capture, mirroring the pattern `trade_ins.idImageUrl` / `signatureUrl` already establish —
  a per-item `slabImageUrl` on `trade_items` is a small, consistent extension.
- Keep the eBay comps link — it becomes supporting evidence for the system's own suggested value instead of the
  only source of one. A better version of the same idea, not a replacement.

## B.8 Migration phases

**Phase B0 · Foundation** — *Schema plus the PkmnPrices listings wrapper — can start independent of Part A's timeline*
- Migration: `card_grading_company` enum, `skus.gradingCompany/grade/certNumber`, updated `skus_identity_uq`, the
  `CHECK` constraint.
- `PkmnPricesClient.listings` wrapper in `integrations/pkmnprices/client.ts`.
- **Exit criteria:** can fetch and log real graded sold-comps for a known card id in a throwaway script.

**Phase B1 · Pricing** — *Aggregation, the new price source, and the pre-existing condition bug*
- Fix Finding 2 regardless of grading — select and actually use `condition` in the pricing router.
- Wire the graded branch through `pricing-router.ts` and `pricing.ts`'s pivot.
- **Exit criteria:** a graded SKU's `current_prices` row reflects a real median of recent sold comps, not an
  Override-only value.

**Phase B2 · Intake persistence** — *The TradeIn.tsx toggle saves what it already collects*
- `TradeItemInput` (shared), `TradeIn.tsx` submit path, `tradeins.ts` service.
- **Exit criteria:** a graded trade-in, reloaded from the database, shows its grading company/grade/cert — today
  it wouldn't.

**Phase B3 · Search, catalog, labels** — *Layer B.5's changes onto a working data model*
- Search filters (web + api), `Inventory.tsx` facets, label/barcode templates.
- **Exit criteria:** staff can filter inventory to "PSA 10 only" and print a label that says so.

**Phase B4 · Nightly sync** — *The weekly graded-refresh batch from B.6*
- New BullMQ job + cron entry, reusing existing batching patterns.
- **Exit criteria:** a graded SKU's price updates on its own, on a cadence that doesn't blow through PkmnPrices'
  credit ceiling.

*No backfill phase — there's no historical graded data to migrate, since none has ever been persisted. A real
advantage of starting this now rather than later.*

## B.9 Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Thin sample sizes | Most grade/card combinations won't have enough recent sold comps to trust an automated median | The Override fallback already exists (Finding 4) — treat "not enough data" as the expected common case |
| eBay listing noise | Sold-listing titles are user-written; mismatched cards/grades can slip into a naive pull | Use the SDK's card-scoped endpoint (already server-side filtered) and drop outliers (e.g. >3× the median) before aggregating |
| Cost | Listings calls are credit-metered per the SDK's rate-limit model | Weekly, not nightly, cadence (B.6); cache aggressively, mirroring the 5–15 min caches already in `routes/pkmnprices.ts` |
| Enum/constraint migration friction | `card_grading_company` and the `condition` nullability change both touch a live, indexed table | Standard expand/contract: add nullable columns first, nothing to backfill, enforce the CHECK constraint last |

## B.10 Effort

| Phase | Size | Why |
|---|---|---|
| B0 Foundation | M | New client surface (cursor pagination) plus a real schema/constraint change on a live table |
| B1 Pricing | M–L | Aggregation logic is genuinely new; also absorbs the pre-existing condition bug fix |
| B2 Intake persistence | S | Mostly plumbing an existing UI's state through to an existing submit path |
| B3 Search, catalog, labels | M | Same shape as existing filters/templates, applied to a new field, across web + api + PDF |
| B4 Nightly sync | S–M | New job, but closely copies established batching patterns |

---

# Combined

## C.0 Recommended sequencing

These aren't really sequential — they share a chokepoint. Part B's entire pricing story depends on the PkmnPrices
`listings` client wrapper (B0), which is genuinely new work regardless of whether Part A has fully retired TCGapi
yet. The pragmatic order: run A0's two spikes first — they answer a real question for both parts — then run B0 in
parallel with A1–A2, since they touch different files.

Land B1's condition-bug fix early even if graded pricing isn't ready — it's a real behavior change that's been
silently wrong regardless of this project. Don't combine A4's schema cleanup and B0's schema addition into the
same migration: one is subtractive on a table everything depends on, the other is additive. Keep them separate and
separately revertable.

## C.1 Decisions needed from you

- **Game scope (A.3):** hard cutover, soft sunset, or manual-only multi-game for the eight non-Pokémon
  categories? A business call about how much non-Pokémon inventory actually moves today.
- **Grade trust threshold (B.4):** what sample size and time window are you comfortable auto-pricing from?
  Affects how often staff sees "not enough data, use Override" in practice.
- **Cert photo capture (B.7):** required at intake, optional, or skipped for now? Affects trade-in flow length at
  the register.
- **`/tcgapi/*` dead-route deletion (A0/A5):** confirm nothing outside this repo calls `routes/tcgapi.ts` directly
  before removing it.

## C.2 Full touchpoint appendix

Every file either initiative touches, for a working checklist during implementation.

**Part A — API, config, jobs**
`integrations/tcgapi/client.ts` · `integrations/pkmnprices/client.ts` · `server/routes/tcgapi.ts` ·
`server/routes/pkmnprices.ts` · `server/routes/settings.ts` · `server/services/config-service.ts` ·
`server/services/pricing-router.ts` · `server/services/pricing.ts` · `server/container.ts` · `jobs/worker.ts` ·
`jobs/cron/catalog-sync.ts` · `scripts/one-off/backfill-pkmnprices-ids.ts` · `security/vault.ts` · `db/schema/` ·
`packages/shared/src/index.ts`

**Part A — Web**
`pages/Onboarding.tsx` · `pages/SettingsIntegrations.tsx` · `pages/Analytics.tsx` ·
`hooks/transactions/useTradeTransaction.ts`

**Part A — Migrations**
`drizzle/0010_tcgapi_query_game_slugs.sql` · `drizzle/0011_pkmnprices_configs.sql` ·
`drizzle/0012_pkmnprices_price_sources.sql` · `drizzle/0013_products_pkmnprices_id.sql`

**Part B — API**
`integrations/pkmnprices/client.ts` · `server/services/pricing-router.ts` · `server/services/pricing.ts` ·
`server/services/tradeins.ts` · `server/services/inventory-import/` · `db/schema/` ·
`packages/shared/src/index.ts`

**Part B — Web**
`pages/TradeIn.tsx` · `pages/Inventory.tsx` · `pages/Analytics.tsx` · `hooks/transactions/useTradeTransaction.ts`

---

*This document is a planning artifact, not a merged plan — treat every phase and effort estimate as a starting
point for your own scoping, and resolve the two flagged spikes (Phase A0) before committing engineering time to
either part.*
