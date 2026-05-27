# TCG Store Inventory & Checkout System — Technical Plan

## 1. System Architecture

**MVP Stack**
- **Frontend:** React 19 + Vite, TypeScript, **TanStack Query** for server state, **Zustand** for local UI state (no Redux, no Context-as-store), Tailwind CSS + shadcn/ui, React Router, `socket.io-client` for real-time, `@zxing/browser` for in-browser scanning.
- **Backend:** **Express** (TypeScript). Keep it lightweight and modular — feature folders (`routes/`, `services/`, `integrations/`, `jobs/`, `db/`, `realtime/`), no framework lock-in beyond Express + middleware. NestJS is explicitly out of scope for MVP.
- **Realtime layer:** Socket.IO (rooms per store/register), Redis adapter for horizontal scaling.
- **Database:** PostgreSQL 16 + **Drizzle ORM** (with `drizzle-kit` migrations).
- **Cache / pub-sub / queues:** Redis (Upstash or Render Key Value).
- **Background jobs:** BullMQ (price refresh, webhook retries, barcode generation).
- **Object storage:** Cloudflare R2 for card images and trade-in receipts; serve via a CDN.
- **Auth:** **Passport.js** strategies (local + JWT) mounted as Express middleware — one auth surface for both the staff console and the register PWA. RBAC roles: `owner`, `manager`, `clerk`, `buyer`. Avoid over-engineering until post-MVP (no Auth.js, no Clerk).
- **Observability:** Pino logs → Logtail/Datadog, Sentry for errors, OpenTelemetry traces.
- **Hosting:** Render Web Service (API), Render Static Site (frontend), Render PostgreSQL, Render Key Value (Redis), Render Background Workers for BullMQ.

## 2. API Integrations

**TCGapi.dev (primary)** — authoritative source for product catalog, pricing, and card data across all supported games. All catalog reads, price refreshes, and on-scan lookups route through a single `TcgApiClient`. Cache bearer/credentials in Redis, nightly catalog sync, hourly price delta for in-stock SKUs, on-demand refresh on scan. Mirror image assets into our own R2 bucket so we don't depend on the upstream CDN.

> **Note:** TCGplayer's first-party API is closed to new applicants and is not used. References to TCGplayer in the legacy scaffold (`apps/api/src/integrations/tcgplayer/`) are slated for removal in the Express refactor.

**Sold-comps / secondary pricing** — not in MVP scope. eBay Browse API does **not** support `soldItemsOnly` / `lastSoldDate` (those live behind the Limited-Release Marketplace Insights API), and the Finding API's `findCompletedItems` is deprecated. If sold-comp medians are needed post-MVP, evaluate paid aggregators (130point, JustTCG) behind the same provider interface.

**Clover (MVP POS)** — MVP integrates with **Clover hardware only** (Clover Mini / Flex / Station, or the Clover Go scanner-equipped mobile device). Square integration is deferred. Keep the POS adapter behind a thin `PosProvider` interface (`createOrder`, `startTerminalCheckout`, `verifyWebhook`) so a future Square or other provider can drop in without touching the checkout flow. The DB remains the source of truth; line items are pushed to Clover as ad-hoc items, then reconciled after payment via Clover webhooks (HMAC-verified).

**Example scan→checkout (Clover)**
```
POST /api/scans          → resolves SKU via TCGapi.dev, returns price/image/stock, emits cart.itemAdded
POST /api/checkout/:id   → Clover create order + start terminal payment
← webhook payments/orders updated (PAID)
→ decrement inventory, emit order.completed
```

## 3. Inventory Management

Tables: `products`, `skus`, `inventory`, `price_snapshots`, `current_prices`, `orders`, `order_items`, `payments`, `trade_ins`, `trade_items`, `customers`, `audit_log`, `webhook_events`, `stores`, `locations`, `users`.

- Money in integer cents.
- `inventory.qty_on_hand` + `qty_reserved`; row-level `SELECT … FOR UPDATE` for checkout/trade.
- Postgres `tsvector` + trigram for fuzzy lookup; `jsonb` for variant attributes.
- Mirror TCGplayer images to R2; store both `source_url` and `cdn_url`.

## 4. Barcode / QR Workflow

- Code128 for thermal labels; QR for trade-in receipts.
- Opaque token (e.g. `TCG-<base32(uuid)>`); **never encode price** in the barcode.
- Generation: `bwip-js` → label PDFs → Brother QL / Zebra ZPL via WebUSB or a small print-bridge.
- Scanning: USB HID scanners behave as keyboards; `@zxing/browser` for camera. Debounce ~750 ms.

## 5. Real-Time Updates

- Namespaces `/register`, `/inventory`, `/admin`; rooms per `store:{id}` / `order:{id}`.
- Redis pub/sub adapter for horizontal scaling.
- Events: `cart.itemAdded`, `cart.itemRemoved`, `cart.totals`, `inventory.updated`, `order.completed`, `order.refunded`, `tradein.created`, `tradein.approved`.
- JWT handshake auth; coalesce price broadcasts to 1/s per SKU.

## 6. POS Checkout Flow (Clover, MVP)

1. `POST /orders` — local order with reservations.
2. `POST /checkout/:id` — Clover create order + start terminal payment via the `PosProvider` adapter.
3. Customer taps card on the Clover device.
4. Clover webhook (payment/order updated) → verify HMAC → mark paid → decrement inventory in a txn → emit `order.completed`.
5. Refunds re-increment inventory and post a reversing audit row.

Idempotency key = `orderId:attempt`. Nightly reconciliation compares Clover vs local orders. Square and other POS providers can be added post-MVP behind the same `PosProvider` interface.

## 7. Trade-In Feature

- Trade value = `min(tcgapi_market, secondary_median) * tier_multiplier(condition, demand)` (MVP uses TCGapi.dev market price only; secondary sold-comp source is post-MVP).
- Tier: NM 0.65 / LP 0.55 / MP 0.45 / HP 0.30 / DMG 0.15 — store credit; cash payout ~70% of credit.
- ID capture + customer signature for high-value trades.
- `pending_approval` for trades over a configurable threshold (default $50).
- Per-customer weekly cap (default $1000); manager override with audit trail.
- Store credit via an internal credit ledger in MVP (Clover gift cards or Square `GiftCards` are post-MVP options).
- QR receipt links to the trade record; per-card barcodes are generated for inventory.

## 8. Hosting & Deployment

Services in `render.yaml`: `tcg-api` (web), `tcg-worker`, `tcg-nightly-catalog` (cron, calls TCGapi.dev), `tcg-web` (static), `tcg-postgres`, `tcg-redis`. Drizzle migrations as a pre-deploy command. Secrets via Render env groups. Read replicas for analytics. Partition `price_snapshots` by month. Zero-downtime: rolling deploys + expand/contract migrations. DR: nightly logical backups; RPO ≤ 24 h, RTO ≤ 2 h.

## 9. Security

- TLS + HSTS. OAuth scopes minimized; tokens encrypted at rest.
- Verify **every** webhook signature; reject on clock skew > 5 min.
- Idempotency tables for webhooks and POS calls.
- RBAC on every endpoint; manager-only routes for voids, refunds, price overrides, and high-value trade approvals.
- PCI: never touch raw card data — Terminal/Hosted checkout only (SAQ-A or SAQ-C-VT scope).
- PII minimization for trade-ins; encrypted + auto-purge after retention.
- Rate-limit public endpoints (IP + user). WAF (Cloudflare) in front.
- CSP, SameSite=strict cookies, CSRF tokens on cookie-auth surfaces.
- Append-only `audit_log` for every inventory/price/trade mutation.
- Dependabot, `npm audit`, CodeQL SAST, secret scanning.

## 10. Pitfalls & Mitigations

- **TCGplayer rate limits / 401s** — n/a for MVP; TCGapi.dev is the sole catalog/pricing source. Centralized client with backoff and circuit breaker still applies.
- **SKU explosion** — deterministic SKU hash on `(product, printing, condition, language)`.
- **Price drift between scan and pay** — lock line-item price at scan; prompt manager only if price moves > X% during cart life.
- **Eventual consistency** — Clover webhook is the commit signal; don't decrement inventory before payment.
- **Duplicate webhooks** — dedupe by `(provider, event_id)` UNIQUE index.
- **Network drops at register** — offline-capable PWA queues scans in IndexedDB; payment requires connectivity.
- **Barcode collisions / reused labels** — never re-issue a token; mark old labels void.
- **Sold-comp data quality** — deferred until a sold-comp source is wired in post-MVP; whatever source is chosen needs outlier filtering (graded, lots, sealed) before computing medians.
- **Trade-in fraud** — ID for high-value, per-customer caps, photograph cards on intake.
- **Time zones** — `timestamptz` everywhere; display in store local TZ.
- **Drizzle migration footguns** — expand/contract pattern; test against prod-sized snapshot.
- **Socket fan-out cost** — coalesce broadcasts, scope rooms tightly.
- **Single-tenant assumptions** — every table carries `store_id`/`location_id`.
- **POS provider lock-in** — all Clover calls go through a `PosProvider` interface so a Square (or other) adapter can be added without changing checkout code.

## Delivery Phasing

1. **Foundations:** repo, CI, Drizzle schema, Express API skeleton, Passport auth, TCGapi.dev catalog sync, React 19 shell wired to TanStack Query + Zustand.
2. **Pricing & Search:** TCGapi.dev refresh jobs, search UI, price history.
3. **Register MVP:** scan → cart → **Clover** terminal → inventory decrement → WS updates.
4. **Trade-Ins:** intake flow, valuation engine, label printing, store credit ledger.
5. **Admin & Reporting:** sales/margin dashboards, audit log viewer, reconciliation.
6. **Hardening:** offline scanning, multi-location, role expansion, observability, load tests. Post-MVP additions live behind interfaces already in place (additional POS providers, sold-comp data sources).
