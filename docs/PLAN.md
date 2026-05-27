# TCG Store Inventory & Checkout System — Technical Plan

## 1. System Architecture

**Recommended Stack**
- **Frontend:** React 18 + Vite, TypeScript, TanStack Query (server-state caching), Zustand or Redux Toolkit (UI state), Tailwind CSS + shadcn/ui, React Router, `socket.io-client` (or native WebSocket) for real-time, `@zxing/browser` or `html5-qrcode` for in-browser scanning.
- **Backend:** **NestJS** (TypeScript) — best fit because it provides first-class WebSocket gateways, modular DI for many third-party API integrations, BullMQ queue support, and clean DTO validation. Alternatives: **Fastify + tRPC** (lighter weight) or **Next.js** (unified deployment), but a separate API service scales more predictably given webhooks and queues.
- **Realtime layer:** Socket.IO (rooms per store/register), Redis adapter for horizontal scaling.
- **Database:** PostgreSQL 16 + **Drizzle ORM** (with `drizzle-kit` migrations).
- **Cache / pub-sub / queues:** Redis (Upstash or Render Key Value).
- **Background jobs:** BullMQ (price refresh, eBay sales sync, webhook retries, barcode generation).
- **Object storage:** Cloudflare R2 or AWS S3 for card images and trade-in receipts; serve via a CDN.
- **Auth:** JWT + refresh tokens for the register PWA. RBAC roles: `owner`, `manager`, `clerk`, `buyer`.
- **Observability:** Pino logs → Logtail/Datadog, Sentry for errors, OpenTelemetry traces, Prometheus metrics via Render.
- **Hosting:** Render Web Service (API), Render Static Site (frontend), Render PostgreSQL, Render Key Value (Redis), Render Background Workers for BullMQ.

## 2. API Integrations

**TCGplayer** — OAuth2 client-credentials; cache bearer in Redis (~7d). Endpoints: `/catalog/categories`, `/catalog/groups`, `/catalog/products`, `/pricing/product/{ids}`, `/pricing/marketplace/{ids}`, `/stores/{storeKey}/inventory/skus`. Strategy: nightly catalog sync, hourly price delta for in-stock SKUs, on-demand refresh on scan.

**Collectr** — secondary metadata/image source. Map to internal SKU by `(tcgplayer_product_id, condition, printing, language)`. Webhooks ingest into `/webhooks/collectr`.

**eBay last-sold** — Browse API `getItemSummaries` with `soldItemsOnly:true`. Rolling 30/90-day medians. Filter graded vs raw, lots, sealed.

**Clover vs Square** — Square recommended for greenfield (cleaner SDKs, sandbox, HMAC-signed webhooks, Terminal API). Keep the DB as source of truth; push line items to POS as ad-hoc items, then reconcile after payment.

**Example scan→checkout (Square)**
```
POST /api/scans          → resolves SKU, returns price/image/stock, emits cart.itemAdded
POST /api/checkout/:id   → Square CreateOrder + CreateTerminalCheckout
← webhook terminal.checkout.updated (COMPLETED)
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

## 6. POS Checkout Flow

1. `POST /orders` — local order with reservations.
2. `POST /checkout/:id` — Square `CreateOrder` then `CreateTerminalCheckout`.
3. Customer taps card.
4. `terminal.checkout.updated` webhook → verify HMAC → mark paid → decrement inventory in a txn → emit `order.completed`.
5. Refunds re-increment inventory and post a reversing audit row.

Idempotency key = `orderId:attempt`. Nightly reconciliation compares POS vs local orders.

## 7. Trade-In Feature

- Trade value = `min(tcgplayer_market, ebay_30d_median) * tier_multiplier(condition, demand)`.
- Tier: NM 0.65 / LP 0.55 / MP 0.45 / HP 0.30 / DMG 0.15 — store credit; cash payout ~70% of credit.
- ID capture + customer signature for high-value trades.
- `pending_approval` for trades over a configurable threshold (default $50).
- Per-customer weekly cap (default $1000); manager override with audit trail.
- Store credit via Square `GiftCards` API, or an internal credit ledger.
- QR receipt links to the trade record; per-card barcodes are generated for inventory.

## 8. Hosting & Deployment

Services in `render.yaml`: `tcg-api` (web), `tcg-worker`, `tcg-nightly-catalog` (cron), `tcg-web` (static), `tcg-postgres`, `tcg-redis`. Drizzle migrations as a pre-deploy command. Secrets via Render env groups. Read replicas for analytics. Partition `price_snapshots` by month. Zero-downtime: rolling deploys + expand/contract migrations. DR: nightly logical backups; RPO ≤ 24 h, RTO ≤ 2 h.

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

- **TCGplayer rate limits / 401s** — centralized client, backoff, circuit breaker, refresh on 401.
- **SKU explosion** — deterministic SKU hash on `(product, printing, condition, language)`.
- **Price drift between scan and pay** — lock line-item price at scan; prompt manager only if price moves > X% during cart life.
- **Eventual consistency** — POS webhook is the commit signal; don’t decrement inventory before payment.
- **Duplicate webhooks** — dedupe by `(provider, event_id)` UNIQUE index.
- **Network drops at register** — offline-capable PWA queues scans in IndexedDB; payment requires connectivity.
- **Barcode collisions / reused labels** — never re-issue a token; mark old labels void.
- **eBay data quality** — outlier filtering (graded, lots, sealed) before computing medians.
- **Trade-in fraud** — ID for high-value, per-customer caps, photograph cards on intake.
- **Time zones** — `timestamptz` everywhere; display in store local TZ.
- **Drizzle migration footguns** — expand/contract pattern; test against prod-sized snapshot.
- **Socket fan-out cost** — coalesce broadcasts, scope rooms tightly.
- **Single-tenant assumptions** — every table carries `store_id`/`location_id`.

## Delivery Phasing

1. **Foundations:** repo, CI, Drizzle schema, TCGplayer catalog sync, React shell.
2. **Pricing & Search:** TCGplayer + eBay refresh jobs, search UI, price history.
3. **Register MVP:** scan → cart → Square Terminal → inventory decrement → WS updates.
4. **Trade-Ins:** intake flow, valuation engine, label printing, store credit ledger.
5. **Admin & Reporting:** sales/margin dashboards, audit log viewer, reconciliation.
6. **Hardening:** offline scanning, multi-location, role expansion, observability, load tests.
