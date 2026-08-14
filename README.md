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
| POS          | **Clover** (exclusive payment processor)                               |
| Catalog      | **TCGapi.dev** (sole source for product, pricing, and card data)       |

## Repo layout

```
apps/
  api/           Express API + WebSocket server + BullMQ worker
    src/db/schema/           Drizzle tables split by domain, re-exported from index.ts
    src/server/routes/       HTTP handlers: validate -> call a service -> shape the response
    src/server/services/     Business logic (inventory-import/ and product-search/ are packages)
    src/integrations/        Outbound clients (pkmncards/ splits transport, parsing, matching)
    src/scripts/one-off/     Completed backfills kept for new environments; not runtime code
  web/           React register / inventory / trade-in UI
    src/hooks/               Data-access hooks owning their TanStack Query keys
    src/lib/                 Pure helpers (formatting, query keys, payout/search math)
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

npm run typecheck   # all workspaces
npm run lint        # eslint; CI fails on any error
npm test            # vitest, api + web
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
Render's managed Postgres currently needs `PG_SSL_REJECT_UNAUTHORIZED=false`
in the shared env group so the API, worker, and nightly cron can connect
without tripping over the database certificate chain.
The Render API service must run database migrations as a *pre-deploy* command
before the worker/cron start; otherwise jobs that query `tcgapi_configs` or
other newer tables will fail against a partially-migrated database.

### Custom domain: theturbocomp.com

Production is served from **theturbocomp.com**. `render.yaml` requests these
custom domains directly on the Blueprint:
- `tcg-web` → `theturbocomp.com` and `www.theturbocomp.com`
- `tcg-api` → `api.theturbocomp.com`

After the Blueprint syncs, each service's **Settings → Custom Domains** tab
in Render shows the DNS records to create at the registrar:
- `theturbocomp.com` (apex) → `ALIAS`/`ANAME` (or `A` records Render provides)
- `www.theturbocomp.com` → `CNAME` to the Render-provided hostname
- `api.theturbocomp.com` → `CNAME` to the Render-provided hostname

Render auto-provisions and renews the TLS certificates once DNS verifies.
Once the domains are live, set these `sync: false` env vars in the Render
dashboard (not committed to the repo):
- `tcg-api` → `CORS_ORIGIN=https://theturbocomp.com,https://www.theturbocomp.com`
- `tcg-api` → `COOKIE_DOMAIN=.theturbocomp.com`
- `tcg-api` → `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`
- `tcg-web` → `VITE_API_URL=https://api.theturbocomp.com`

### Firebase Authentication migration foundation

Migration `0021_firebase_uid_prep.sql` adds a nullable, unique Firebase UID
mapping without disabling the existing JWT login. Once Firebase Admin is
configured, the API accepts Firebase RS256 ID tokens alongside legacy HS256
tokens and still resolves store membership, roles, and disabled state from
Postgres.

Before importing production users, take a database snapshot and run the
dry-run command `npm run firebase:import-users --workspace=@tcg/api`. Review
the redacted counts, then run the same command with `-- --apply`. The importer
preserves existing passwords through Firebase's BCRYPT import and uses each
existing application user UUID as its Firebase UID. Do not remove the legacy
password/session schema until the import and sign-in have been reconciled.

## High-level request flow

```
[React PWA] ── HTTPS/WSS ──► [Express API + Socket.IO] ── pub/sub ─► [Redis]
                                  │                                    │
                                  ▼                                    ▼
                            [Postgres + Drizzle]              [BullMQ Workers]
                                                                       │
                                              TCGapi.dev / Clover
```

## SKU barcodes

Every SKU's `barcode` column equals its primary-key UUID; scanners therefore
read the SKU directly without a separate lookup table. Image endpoints:

| Endpoint                                         | Returns                |
|--------------------------------------------------|------------------------|
| `GET /api/skus/:id/barcode.png?format=code128`   | Code 128 PNG (default) |
| `GET /api/skus/:id/barcode.png?format=qr`        | QR code PNG            |
| `GET /api/barcodes/:token.png?format=...`        | Same, keyed on barcode |
| `POST /api/skus/labels.pdf`                      | Avery 5160 or Nelko 14×40mm PDF |

`POST /api/skus/labels.pdf` accepts `{ items: [{ skuId, copies? }, ...], sheet?: 'avery5160' | 'nelko14x40' }`
(up to 500 labels total). Use `sheet: 'nelko14x40'` for 40mm × 14mm label
stock on a Nelko printer, or leave it unset for Avery 5160 sheets. Existing
rows can be backfilled with
`npm run backfill:sku-barcodes -w @tcg/api`.

Key flows:
- **Scan → Cart:** `POST /api/scans` resolves a barcode to a SKU (via TCGapi.dev),
  reserves stock, and emits `cart.itemAdded` over WS.
- **Checkout:** `POST /api/orders/:id/checkout` starts a Clover terminal payment
  through `CloverClient`. Clover's payment/order webhook decrements
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

For step-by-step setup — prerequisites, env vars, migrations, integrations,
Render deploy, and an operational checklist — see
[`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).
