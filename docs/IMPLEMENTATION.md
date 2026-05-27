# Implementation Guide

A step-by-step walkthrough for getting the TCG Toolkit running locally and
deployed to Render. Pair this with [`PLAN.md`](./PLAN.md) (architecture &
rationale) and the top-level [`README.md`](../README.md) (quick reference).

> Audience: a developer or store operator setting this system up from a fresh
> clone for the first time.

---

## 1. Prerequisites

| Tool             | Version            | Notes                                              |
|------------------|--------------------|----------------------------------------------------|
| Node.js          | 20.x LTS or newer  | Enforced in root `package.json` `engines.node`.    |
| npm              | 10.x (ships w/ 20) | Workspaces (`apps/*`, `packages/*`) are required.  |
| PostgreSQL       | 16                 | Local install or Docker.                           |
| Redis            | 7                  | Local install or Docker. Used by BullMQ + Socket.IO.|
| Docker (optional)| latest             | Easiest way to run Postgres + Redis.               |
| Git              | any modern         | —                                                  |

Accounts / credentials you will need before going past local dev:

- **TCGapi.dev** API key — sole catalog & pricing source.
- **Clover** developer account, sandbox merchant, access token, and webhook
  signing secret — MVP POS.
- **Cloudflare R2** bucket + access keys — image mirroring & trade-in receipts
  (optional for first boot; required before production).
- **Render** account — hosting target described in `render.yaml`.
- **Sentry** DSN — optional observability.

---

## 2. Repository layout

```
apps/
  api/           Express API + Socket.IO server + BullMQ worker (@tcg/api)
  web/           React 19 + Vite register / inventory / trade-in UI (@tcg/web)
packages/
  shared/        Zod schemas, enums, socket event names, DTO types (@tcg/shared)
docs/
  PLAN.md          High-level technical plan
  IMPLEMENTATION.md  ← this file
render.yaml      Render blueprint (web + worker + cron + static + Postgres + KV)
```

Workspaces are wired through the root `package.json`. Always install from the
repo root so cross-workspace symlinks resolve correctly.

---

## 3. First-time local setup

### 3.1 Clone & install

```sh
git clone https://github.com/coyotewindgames/TCG-Toolkit.git
cd TCG-Toolkit
npm install
```

`npm install` at the root installs every workspace and links `@tcg/shared`
into both apps.

### 3.2 Start Postgres & Redis

Easiest path — Docker:

```sh
docker run -d --name tcg-pg    -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
docker run -d --name tcg-redis -p 6379:6379 redis:7
```

Create the database the API expects (default `tcg`):

```sh
docker exec -it tcg-pg psql -U postgres -c "CREATE DATABASE tcg;"
```

If you run Postgres/Redis natively, just point the env vars in the next step at
your installs.

### 3.3 Configure environment

```sh
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env`. The variables you must touch on first boot:

| Var                              | Purpose                                         | First-boot value                                   |
|----------------------------------|-------------------------------------------------|----------------------------------------------------|
| `DATABASE_URL`                   | Postgres connection                             | `postgres://postgres:postgres@localhost:5432/tcg`  |
| `REDIS_URL`                      | Redis (BullMQ + Socket.IO adapter)              | `redis://localhost:6379`                           |
| `JWT_SECRET`                     | Signs access tokens                             | Any string ≥ 16 chars (do **not** ship the default)|
| `CORS_ORIGIN`                    | Allowed web origin                              | `http://localhost:5173`                            |
| `TCGAPI_KEY`                     | Catalog & pricing                               | Your TCGapi.dev key                                |
| `CLOVER_ACCESS_TOKEN`            | POS calls                                       | Sandbox token                                      |
| `CLOVER_MERCHANT_ID`             | POS calls                                       | Sandbox merchant id                                |
| `CLOVER_WEBHOOK_SIGNING_SECRET`  | HMAC verifying Clover webhooks                  | Sandbox secret                                     |
| `R2_*`                           | Image mirroring                                 | Optional until you need image sync                 |
| `SENTRY_DSN`                     | Error reporting                                 | Optional                                           |

The web app reads its API base URL from `VITE_API_URL`. Locally you can leave
it unset — Vite proxies `/api` and `/socket.io` to `http://localhost:3000`
(see `apps/web/vite.config.ts`).

### 3.4 Run database migrations

The schema lives in `apps/api/src/db/schema.ts` and is managed by Drizzle Kit.

For day-to-day local development, push the schema directly:

```sh
npm run db:push --workspace=@tcg/api
```

When you change `schema.ts`, generate a migration and apply it:

```sh
npm run db:generate --workspace=@tcg/api    # writes SQL to apps/api/drizzle/
npm run db:migrate  --workspace=@tcg/api    # tsx src/db/migrate.ts
```

### 3.5 Start the dev processes

Open three terminals from the repo root:

```sh
# 1) API + Socket.IO (port 3000)
npm run dev --workspace=@tcg/api

# 2) BullMQ worker (price refresh, webhook retries, barcode generation)
npm run worker --workspace=@tcg/api

# 3) React register / admin UI (port 5173)
npm run dev --workspace=@tcg/web
```

Visit `http://localhost:5173`. The UI talks to `http://localhost:3000` via the
Vite dev proxy and opens a Socket.IO connection over the same origin.

Smoke checks:

- `curl http://localhost:3000/healthz` returns `200`.
- The worker logs `worker ready` and connects to Redis.
- The web app loads without CORS errors in the browser console.

---

## 4. Day-to-day workflows

### 4.1 Build everything

```sh
npm run build --workspace=@tcg/shared   # build shared first; apps depend on it
npm run build --workspace=@tcg/api
npm run build --workspace=@tcg/web
# or, from the repo root:
npm run build
```

### 4.2 Type-check

```sh
npm run typecheck --workspace=@tcg/api
npm run typecheck --workspace=@tcg/web
# or:
npm run typecheck
```

### 4.3 Test

```sh
npm test --workspace=@tcg/api    # Vitest
npm test                         # all workspaces
```

### 4.4 Adding a feature

1. If a new request/response shape is involved, add a Zod schema and any shared
   enums/event names to `packages/shared/src/` and re-export them.
2. Add the route under `apps/api/src/server/routes/` and the business logic
   under `apps/api/src/server/services/`. Mount auth + RBAC middleware on the
   route. Validate input with the shared Zod schema.
3. If you need a background task, enqueue it via `apps/api/src/jobs/queues.ts`
   and add a processor in `apps/api/src/jobs/worker.ts`.
4. Emit Socket.IO events using the constants from `@tcg/shared`; never hardcode
   event strings on either side.
5. On the web side, add a TanStack Query hook for server state and Zustand
   slice for transient UI state. Do not put server data in Zustand.

---

## 5. Integrations

### 5.1 TCGapi.dev (catalog + pricing)

- All catalog reads, on-scan lookups, and price refreshes go through the single
  client in `apps/api/src/integrations/tcgapi/`.
- Nightly catalog sync runs as the `tcg-nightly-catalog` cron
  (`src/jobs/cron/catalog-sync.ts`) at 07:00 UTC.
- Hourly price deltas for in-stock SKUs and on-demand scan refreshes are
  enqueued to BullMQ and handled by the worker.
- Set `TCGAPI_KEY` in the env. Without it, scans and sync jobs fail closed —
  this is intentional.

### 5.2 Clover (POS)

- POS calls are abstracted behind the `PosProvider` interface in
  `apps/api/src/integrations/pos/`. Clover is the MVP implementation.
- Set `CLOVER_BASE_URL` (sandbox vs prod), `CLOVER_ACCESS_TOKEN`,
  `CLOVER_MERCHANT_ID`, and `CLOVER_WEBHOOK_SIGNING_SECRET`.
- Webhooks land at `POST /webhooks/clover`. The webhook router uses raw-body
  middleware so HMAC verification can run before JSON parsing. Reject requests
  with clock skew > 5 minutes.
- Idempotency: every webhook is deduped by `(provider, providerEventId)`.

To exercise the flow end-to-end you need a Clover sandbox merchant and either a
Clover Mini/Flex device or the Clover device simulator. The local order is the
source of truth; Clover only confirms the payment.

### 5.3 Cloudflare R2 (optional for first boot)

Used for mirroring TCGapi.dev card images and storing generated trade-in
receipt PDFs. Set the four `R2_*` vars when you are ready to enable image sync.

---

## 6. Authentication & roles

- Passport.js provides both `local` (email + password) and `jwt` strategies.
  The same auth surface serves the staff console and register PWA.
- Access tokens are short-lived (`JWT_ACCESS_TTL_SECONDS`, default 15 min);
  refresh tokens are stored in an `HttpOnly` cookie named `tcg_refresh` and
  rotated on use.
- RBAC roles: `owner`, `manager`, `clerk`, `buyer`. Apply role middleware on
  every route — manager-only actions include voids, refunds, price overrides,
  and high-value trade approvals.
- Seed at least one `owner` user during initial bring-up. Until a seed script
  exists, insert one manually via `psql` after `db:push`:

  ```sql
  INSERT INTO users (email, password_hash, role)
  VALUES ('owner@example.com', '<bcrypt-hash>', 'owner');
  ```

  Generate the bcrypt hash with `node -e "console.log(require('bcrypt').hashSync('changeme', 12))"`.

---

## 7. Real-time layer

- Socket.IO namespaces: `/register`, `/inventory`, `/admin`. Rooms are scoped
  by `store:{id}` and `order:{id}`.
- The Redis adapter (`@socket.io/redis-adapter`) backs horizontal scaling. In
  local dev a single API process still uses Redis so behavior matches prod.
- JWT is verified at the handshake; reject connections without a valid token.
- Event names come from `@tcg/shared` — e.g. `cart.itemAdded`,
  `inventory.updated`, `order.completed`, `tradein.approved`.

---

## 8. Background jobs

- Queues are defined in `apps/api/src/jobs/queues.ts`.
- The worker entry point is `apps/api/src/jobs/worker.ts`
  (`npm run worker --workspace=@tcg/api`).
- Cron entries live under `apps/api/src/jobs/cron/` and are invoked directly by
  Render's cron service. They share the API build output.
- Common jobs: nightly catalog sync, hourly price deltas, webhook retries,
  barcode/label generation, receipt rendering.

---

## 9. Deploying to Render

The blueprint in [`render.yaml`](../render.yaml) provisions:

| Service                | Type        | Start command                                   |
|------------------------|-------------|-------------------------------------------------|
| `tcg-api`              | web         | `node apps/api/dist/server/main.js`             |
| `tcg-worker`           | worker      | `node apps/api/dist/jobs/worker.js`             |
| `tcg-nightly-catalog`  | cron 07:00Z | `node apps/api/dist/jobs/cron/catalog-sync.js`  |
| `tcg-web`              | static      | builds `apps/web` and serves `dist/`            |
| `tcg-postgres`         | Postgres 16 | —                                               |
| `tcg-redis`            | Key Value   | —                                               |

Steps:

1. In Render, choose **New → Blueprint** and point at the GitHub repo.
2. Render parses `render.yaml` and shows the services it will create. Confirm.
3. Fill in every env var marked `sync: false` in `render.yaml`:
   - `TCGAPI_KEY`
   - `CLOVER_BASE_URL`, `CLOVER_ACCESS_TOKEN`, `CLOVER_MERCHANT_ID`,
     `CLOVER_WEBHOOK_SIGNING_SECRET`
   - `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   - `CORS_ORIGIN` (the public URL of `tcg-web`)
   - `SENTRY_DSN` (optional)
   - On `tcg-web`: `VITE_API_URL` (public URL of `tcg-api`) and
     `VITE_CLOVER_DEVICE_ID`.
4. Add a Render **pre-deploy command** on `tcg-api` to run migrations:
   `npx drizzle-kit migrate` (or `node apps/api/dist/db/migrate.js` once that
   script is built). This is intentionally separate from the start command so a
   failed migration blocks the deploy instead of crash-looping the service.
5. First deploy: Render builds each service, runs the pre-deploy migration,
   and starts the API, worker, and static site. The cron service idles until
   07:00 UTC.
6. Register the Clover webhook URL: `https://<tcg-api-host>/webhooks/clover`.
   Use the same signing secret you placed in `CLOVER_WEBHOOK_SIGNING_SECRET`.

Health check: Render polls `/healthz` on `tcg-api`. If that fails, a deploy
will not go live.

---

## 10. Operational checklist

Before letting a real store ring a sale:

- [ ] At least one `owner` user exists; default credentials have been rotated.
- [ ] `JWT_SECRET` is unique to the environment and ≥ 32 chars.
- [ ] TCGapi.dev key is set and the catalog sync has completed at least once.
- [ ] Clover sandbox flow has been exercised end-to-end:
      scan → cart → terminal payment → webhook → inventory decrement →
      `order.completed` event observed in the register UI.
- [ ] Webhook signature verification rejects an intentionally tampered payload.
- [ ] R2 bucket exists and the worker has mirrored at least one image.
- [ ] Database backup schedule is enabled on the Render Postgres service.
- [ ] Sentry (or equivalent) is receiving errors from the API and worker.
- [ ] Rate limits (`express-rate-limit`) are configured on public endpoints.
- [ ] CSP, HSTS, and `SameSite=strict` cookies are verified in the deployed UI.

---

## 11. Troubleshooting

| Symptom                                              | Likely cause / fix                                                                       |
|------------------------------------------------------|------------------------------------------------------------------------------------------|
| `ECONNREFUSED 5432` on API start                     | Postgres not running or `DATABASE_URL` wrong.                                            |
| `ECONNREFUSED 6379` on API or worker start           | Redis not running or `REDIS_URL` wrong.                                                  |
| CORS error in the browser                            | `CORS_ORIGIN` does not match the URL you loaded the web app from.                        |
| Socket.IO disconnects immediately after handshake    | Missing/expired JWT, or `JWT_SECRET` differs between issuer and verifier.                |
| `401` from TCGapi.dev                                | `TCGAPI_KEY` missing or revoked.                                                         |
| Clover webhook returns 400                           | HMAC mismatch — verify signing secret and that raw-body middleware is mounted on `/webhooks/*`. |
| Duplicate inventory decrements                        | Webhook idempotency table not consulted, or `(provider, providerEventId)` not unique.    |
| Drizzle migration fails on prod                      | Schema change is not expand/contract safe — split into additive + cleanup migrations.    |
| `@tcg/shared` types out of date in an app            | Rebuild it: `npm run build --workspace=@tcg/shared`.                                     |

---

## 12. Where to go next

- Read [`PLAN.md`](./PLAN.md) for the architecture rationale, schema notes,
  trade-in valuation model, and security posture.
- See `apps/api/REFACTOR.md` for the in-progress notes on the Express refactor.
- Open issues / PRs for anything that drifts from this guide so it stays
  accurate.
