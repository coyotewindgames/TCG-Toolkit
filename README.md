# TCG-Toolkit

Inventory, register, and trade-in stack for a Trading Card Game (TCG) store.
Integrates with **TCGapi.dev** for catalog/pricing data and **Clover** hardware
for in-store checkout.

> The repository implements the system described in
> [`docs/PLAN.md`](docs/PLAN.md): Express + Passport, TanStack Query + Zustand,
> Clover-only POS, and TCGapi.dev as the sole catalog/pricing source.

## Stack (MVP)

| Layer        | Choice                                                                 |
|--------------|------------------------------------------------------------------------|
| Frontend     | React 19 + Vite + TypeScript + Tailwind, **TanStack Query** (server state), **Zustand** (UI state), socket.io-client, `@zxing/browser` |
| Backend      | **Express** (TypeScript), Socket.IO, BullMQ workers, **Passport.js** auth |
| Database     | PostgreSQL 16 + Drizzle ORM (`drizzle-kit` migrations)                 |
| Cache/queues | Redis (BullMQ + Socket.IO Redis adapter)                               |
| Hosting      | Render (web, worker, cron, static, Postgres, Key Value)                |
| POS          | **Clover** (MVP); behind a `PosProvider` interface for future swaps    |
| Catalog      | **TCGapi.dev** (sole source for product, pricing, and card data)       |

## Repo layout

```
apps/
  api/           Express API + WebSocket server + BullMQ worker
  web/           React register / inventory / trade-in UI
packages/
  shared/        Zod schemas, enums, socket event names, shared DTO types
render.yaml      Render blueprint: web + worker + cron + static + Postgres + Redis
```

## Local development

Prereqs: Node 20+, Docker (for Postgres + Redis) or local installs.

```sh
# 1. install everything
npm install

# 2. start postgres + redis (any way you like)
docker run -d --name tcg-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
docker run -d --name tcg-redis -p 6379:6379 redis:7

# 3. configure env
cp apps/api/.env.example apps/api/.env
# edit DATABASE_URL / REDIS_URL / provider keys

# 4. run migrations
npm run db:push --workspace=@tcg/api

# 5. start the API + Socket.IO server
npm run dev --workspace=@tcg/api

# 6. start a BullMQ worker (separate terminal)
npm run worker --workspace=@tcg/api

# 7. start the React register
npm run dev --workspace=@tcg/web
```

The web dev server proxies `/api` and `/socket.io` to the API on port 3000.

## Build & validate

```sh
npm run build --workspace=@tcg/shared
npm run build --workspace=@tcg/api
npm run build --workspace=@tcg/web

npm run typecheck --workspace=@tcg/api
npm run typecheck --workspace=@tcg/web
```

## Deploying to Render

The blueprint in [`render.yaml`](./render.yaml) provisions:
- `tcg-api` — Express web service (REST + Socket.IO)
- `tcg-worker` — BullMQ background worker
- `tcg-nightly-catalog` — cron job (07:00 UTC) for TCGapi.dev catalog sync
- `tcg-web` — React static site
- `tcg-postgres` — PostgreSQL 16
- `tcg-redis` — Render Key Value

Click **New → Blueprint** in Render, point at this repo, then fill in the
`sync: false` secrets (TCGapi.dev key, Clover tokens, etc.).
Drizzle migrations should run on deploy via a Render *pre-deploy* command
(`npx drizzle-kit migrate`).

## High-level request flow

```
[React PWA] ── HTTPS/WSS ──► [Express API + Socket.IO] ── pub/sub ─► [Redis]
                                  │                                    │
                                  ▼                                    ▼
                            [Postgres + Drizzle]              [BullMQ Workers]
                                                                       │
                                              TCGapi.dev / Clover
```

Key flows:
- **Scan → Cart:** `POST /api/scans` resolves a barcode to a SKU (via TCGapi.dev),
  reserves stock, and emits `cart.itemAdded` over WS.
- **Checkout:** `POST /api/orders/:id/checkout` starts a Clover terminal payment
  through the `PosProvider` adapter. Clover's payment/order webhook decrements
  `qty_on_hand` and emits `order.completed`.
- **Trade-In:** `POST /api/tradeins` accepts a `CreateTradeRequest` (location,
  payout kind, items with condition/printing/language/quantity), suggests a
  tiered valuation server-side (`tcgapi_market * tier_multiplier` in MVP),
  finalizes the trade, mints barcodes for received cards, and credits the
  customer.

## Security highlights

- HMAC verification on every POS webhook (raw-body middleware on `/webhooks/*`).
- Idempotency table keyed by `(provider, providerEventId)`.
- PCI scope: we never touch a card; Clover Terminal handles entry.
- Auth via Passport.js (local + JWT strategies) — one auth surface for staff and registers.
- RBAC roles: `owner`, `manager`, `clerk`, `buyer`.
- Per-customer trade-in caps + manager-approval threshold to mitigate fraud.
- All mutations recorded in `audit_log` with actor + reason.

See the full plan in [`docs/PLAN.md`](docs/PLAN.md) for the complete write-up
(architecture, integrations, schema, real-time, POS flows, trade-ins, deployment,
security, and a list of pitfalls to avoid).
