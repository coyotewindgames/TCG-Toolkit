# `apps/api` Refactor Inventory

This document is the route/event/queue/webhook checklist for the
NestJS → Express + TCGapi.dev + Clover refactor described in
[`/docs/PLAN.md`](../../docs/PLAN.md). The end-state of this PR
matches the plan; this file remains as the cross-reference for
future maintenance.

## HTTP routes

All API routes are mounted under the `/api` prefix except health
probes.

| Method | Path                                    | Role(s)                  | Notes |
|--------|-----------------------------------------|--------------------------|-------|
| GET    | `/healthz`                              | public                   | liveness |
| GET    | `/readyz`                               | public                   | readiness |
| POST   | `/api/auth/login`                       | public                   | local strategy → JWT + refresh cookie |
| POST   | `/api/auth/refresh`                     | refresh cookie           | rotates refresh token, issues new JWT |
| POST   | `/api/auth/logout`                      | refresh cookie           | revokes refresh token |
| GET    | `/api/auth/me`                          | authenticated            | current user |
| GET    | `/api/products/search?q=`               | authenticated            | catalog search |
| POST   | `/api/scans`                            | authenticated            | barcode → SKU + price + stock |
| POST   | `/api/orders`                           | authenticated            | new open order |
| GET    | `/api/orders/:id`                       | authenticated            | order + items |
| POST   | `/api/orders/:id/items`                 | authenticated            | scan-into-cart |
| DELETE | `/api/orders/:id/items/:lineId`         | authenticated            | remove cart line |
| POST   | `/api/orders/:id/checkout`              | clerk / manager / owner  | start Clover terminal checkout |
| POST   | `/api/tradeins`                         | authenticated            | create trade |
| POST   | `/api/tradeins/:id/approve`             | manager / owner          | approve `pending_approval` trade |
| GET    | `/api/tradeins/barcode/:token.png`      | authenticated            | Code128 PNG |
| GET    | `/api/tradeins/qr/:token.png`           | authenticated            | QR PNG |
| POST   | `/webhooks/clover`                      | public + HMAC verified   | raw body required |

## Socket.IO events

Single namespace; rooms `store:{id}` / `register:{store}:{reg}` /
`order:{id}`. Event names exported from `@tcg/shared`.

- `cart.itemAdded`
- `cart.itemRemoved`
- `cart.totals`
- `inventory.updated`
- `order.completed`
- `order.refunded`
- `tradein.created`
- `tradein.approved`

Client → server:

- `order.join` `{ orderId }` — join an order room

## BullMQ queues

| Queue                  | Trigger                       | Purpose |
|------------------------|-------------------------------|---------|
| `price-refresh`        | hourly + on-demand            | TCGapi.dev price refresh for in-stock SKUs |
| `tcgapi-catalog-sync`  | nightly cron (07:00 UTC)      | TCGapi.dev catalog walk |
| `image-mirror`         | after catalog/price upserts   | mirror TCGapi.dev images into R2 (stubbed) |
| `webhook-retry`        | on webhook processing failure | re-process inbound webhooks |

## Inbound webhooks

- `POST /webhooks/clover` — Clover payment / order updates. Raw body parsed,
  HMAC verified using `CLOVER_WEBHOOK_SIGNING_SECRET`. Deduped via
  `webhook_events (provider, provider_event_id)` unique index.

## External integrations

- `TcgapiClient` (`apps/api/src/integrations/tcgapi/`) — sole catalog &
  pricing source. Operations used: `searchProducts`, `getProduct`,
  `getPricing`, `imageUrl`.
- `PosProvider` interface (`apps/api/src/integrations/pos/`) with
  `CloverProvider` as the only implementation in MVP. Future Square,
  etc. plug in without changes to checkout.

## Removed in this refactor

- All `@nestjs/*` packages, `nest-cli.json`, the `modules/` tree, and the
  `AppModule` composition root.
- `TcgplayerClient`, `SquareClient`, `EbayClient`, `CollectrClient` and
  their env vars (`TCGPLAYER_*`, `SQUARE_*`, `EBAY_*`, `COLLECTR_*`).
- `priceSourceEnum` values `tcgplayer_*` and `ebay_*` — replaced with
  `tcgapi_market`, `tcgapi_low`, `tcgapi_mid`, `tcgapi_high`, and
  `manual_override` is retained.
- `posProviderEnum` reduced to `clover` for MVP (the column is kept as
  an enum so adding `square` later is a single migration).
