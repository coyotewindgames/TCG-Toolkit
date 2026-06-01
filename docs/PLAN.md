# TCG Store Inventory & Checkout System — Technical Plan

## 1. System Architecture

**MVP Stack**
- **Frontend:** React 19 + Vite, TypeScript, **TanStack Query** for server state, **Zustand** for local UI state (no Redux, no Context-as-store), Tailwind CSS + shadcn/ui, React Router, `socket.io-client` for real-time, `@zxing/browser` for in-browser scanning.
- **Backend:** **Express** (TypeScript). Keep it lightweight and modular — feature folders (`routes/`, `services/`, `integrations/`, `jobs/`, `db/`, `realtime/`), no framework lock-in beyond Express + middleware. NestJS is explicitly out of scope for MVP.
- **Realtime layer:** Socket.IO (rooms per store/register), Redis adapter for horizontal scaling.
- **Database:** PostgreSQL 16 + **Drizzle ORM** (with `drizzle-kit` migrations).
- **Cache / pub-sub / queues:** Redis (Upstash or Render Key Value).
- **Background jobs:** BullMQ (price refresh, webhook retries, catalog sync).
- **Object storage:** none. Card images are referenced by their TCGapi.dev source URL; receipts are streamed on demand. Add object storage only if/when bulk image hosting becomes a constraint.
- **Auth:** **Passport.js** strategies (local + JWT) mounted as Express middleware — one auth surface for both the staff console and the register PWA. RBAC roles: `owner`, `manager`, `clerk`, `buyer`. Avoid over-engineering until post-MVP (no Auth.js, no Clerk).
- **Observability:** Pino logs → Logtail/Datadog, Sentry for errors, OpenTelemetry traces.
- **Hosting:** Render Web Service (API), Render Static Site (frontend), Render PostgreSQL, Render Key Value (Redis), Render Background Workers for BullMQ.

## 2. API Integrations

**TCGapi.dev** — sole authoritative source for product catalog, pricing, and card data across all supported games. All catalog reads, price refreshes, and on-scan lookups route through a single `TcgapiClient` against `https://api.tcgapi.dev/v1` with an `X-API-Key` header. Nightly catalog sync walks the local `products` table and refreshes name/set/rarity/imageSourceUrl; hourly price refresh requests `/cards/:id/prices` per in-stock SKU; on-demand refresh fires on scan. Images are served directly from the upstream `image_url` — no mirroring.

**Sold-comps / secondary pricing** — not in scope. If sold-comp medians are needed later, evaluate paid aggregators (130point, JustTCG) and integrate behind the existing `TcgapiClient` pattern.

**Clover (exclusive POS)** — Clover is the only payment processor for this system. Integration targets Clover hardware (Clover Mini / Flex / Station / Go). Line items are pushed to Clover as ad-hoc items, then reconciled after payment via Clover webhooks (HMAC-verified). The DB remains the source of truth. There is no `PosProvider` abstraction — `CloverClient` is consumed directly by checkout and webhook handlers.

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
- Product images: store only `image_source_url` (upstream TCGapi.dev URL). No mirror.

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

## 6. POS Checkout Flow (Clover)

1. `POST /orders` — local order with reservations.
2. `POST /checkout/:id` — Clover create order + start terminal payment via `CloverClient`.
3. Customer taps card on the Clover device.
4. Clover webhook (payment/order updated) → verify HMAC → mark paid → decrement inventory in a txn → emit `order.completed`.
5. Refunds re-increment inventory and post a reversing audit row.

Idempotency key = `orderId:attempt`. Nightly reconciliation compares Clover vs local orders. Clover is the exclusive payment processor; there is no plan to support additional POS vendors.

## 7. Trade-In Feature

- Trade value = `min(tcgapi_market, secondary_median) * tier_multiplier(condition, demand)` (MVP uses TCGapi.dev market price only; secondary sold-comp source is post-MVP).
- Tier: NM 0.65 / LP 0.55 / MP 0.45 / HP 0.30 / DMG 0.15 — store credit; cash payout ~70% of credit.
- ID capture + customer signature for high-value trades.
- `pending_approval` for trades over a configurable threshold (default $50).
- Per-customer weekly cap (default $1000); manager override with audit trail.
- Store credit via an internal credit ledger.
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

- **Catalog/pricing rate limits / 401s** — TCGapi.dev is the sole catalog/pricing source. Centralized client with backoff and circuit breaker.
- **SKU explosion** — deterministic SKU hash on `(product, printing, condition, language)`.
- **Price drift between scan and pay** — lock line-item price at scan; prompt manager only if price moves > X% during cart life.
- **Eventual consistency** — Clover webhook is the commit signal; don't decrement inventory before payment.
- **Duplicate webhooks** — dedupe by `(provider, event_id)` UNIQUE index.
- **Network drops at register** — offline-capable PWA queues scans in IndexedDB; payment requires connectivity.
- **Barcode collisions / reused labels** — never re-issue a token; mark old labels void.
- **Sold-comp data quality** — not in scope; if added later, the chosen source needs outlier filtering (graded, lots, sealed) before computing medians.
- **Trade-in fraud** — ID for high-value, per-customer caps, photograph cards on intake.
- **Time zones** — `timestamptz` everywhere; display in store local TZ.
- **Drizzle migration footguns** — expand/contract pattern; test against prod-sized snapshot.
- **Socket fan-out cost** — coalesce broadcasts, scope rooms tightly.
- **Single-tenant assumptions** — every table carries `store_id`/`location_id`.
- **Clover dependency** — Clover is the exclusive payment processor. `CloverClient` is consumed directly by checkout and webhook handlers; outages are mitigated by retry queues and offline-capable scan queueing, not by a fallback provider.

## Delivery Phasing

1. **Foundations:** repo, CI, Drizzle schema, Express API skeleton, Passport auth, TCGapi.dev catalog sync, React 19 shell wired to TanStack Query + Zustand.
2. **Pricing & Search:** TCGapi.dev refresh jobs, search UI, price history.
3. **Register MVP:** scan → cart → **Clover** terminal → inventory decrement → WS updates.
4. **Trade-Ins:** intake flow, valuation engine, label printing, store credit ledger.
5. **Admin & Reporting:** sales/margin dashboards, audit log viewer, reconciliation.
6. **Hardening:** offline scanning, multi-location, role expansion, observability, load tests.
